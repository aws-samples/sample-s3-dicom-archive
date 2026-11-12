"""Minimal helper for writing processing-job plugins in Python.

Copy this file into your plugin image. It implements the container side of the
contract in docs/PLUGINS.md so the plugin itself only has to do its work:

    from plugin_sdk import Step

    def main():
        with Step() as step:                 # loads steps/<n>/input.json
            files = step.download_all()      # instances -> local files
            ...                              # do the work
            step.put_output('result.png', data, 'image/png', label='Preview')
            step.succeed('Rendered 1 image')

Leaving the `with` block without calling succeed()/skip() records FAILED with
the exception text, so a crash still produces a readable result.

Pipelines: in a chained stage, `step.upstream` describes the previous stage's
step for the same series/study, and `step.download_upstream()` fetches its
outputs. Write-back: `step.write_back` is True when the run will store DICOM
outputs in the archive; emit them with put_dicom() and new UIDs.
"""
import json
import os
import sys
import tempfile
import traceback
import urllib.request
import urllib.parse
from pathlib import Path


def _validated_download_url(url):
    """Reject any non-http(s) URL before handing it to urlopen (Bandit B310).

    Step input URLs are presigned S3 https URLs supplied by the pipeline, not
    user input, but an unchecked urlopen() would also honour file://, ftp:// and
    other schemes — turning a malformed/injected URL into a local-file read or
    SSRF. Allow only http/https and return the url unchanged; raise otherwise."""
    scheme = urllib.parse.urlsplit(url).scheme.lower()
    if scheme not in ('https', 'http'):
        raise ValueError(f"refusing to fetch non-http(s) URL scheme: {scheme!r}")
    return url

import boto3

_BUCKET = os.environ['PLUGIN_IO_BUCKET']
_PREFIX = os.environ['PLUGIN_RUN_PREFIX'].rstrip('/') + '/'
_INDEX = int(os.environ.get('AWS_BATCH_JOB_ARRAY_INDEX') or 0)
_s3 = boto3.client('s3')


class Step:
    def __init__(self):
        self.index = _INDEX
        self.base = f'{_PREFIX}steps/{self.index}/'
        body = _s3.get_object(Bucket=_BUCKET, Key=self.base + 'input.json')['Body'].read()
        self.input = json.loads(body)
        try:
            self.params = json.loads(os.environ.get('PLUGIN_PARAMS') or '{}')
        except ValueError:
            self.params = {}
        self.params = {**self.input.get('params', {}), **self.params}
        self.workdir = Path(tempfile.mkdtemp(prefix='plugin-'))
        self._outputs = []
        self._metrics = {}
        self._done = False

    @property
    def run_id(self):
        """This run's id (the runs/<runId>/ prefix). Stable across the run's steps."""
        parts = _PREFIX.strip('/').split('/')
        return parts[1] if len(parts) > 1 and parts[0] == 'runs' else _PREFIX.strip('/')

    # -- inputs ---------------------------------------------------------------
    @property
    def instances(self):
        """Instances for a series-granularity step (all series flattened for study steps)."""
        if 'instances' in self.input:
            return self.input['instances']
        return [i for s in self.input.get('series', []) for i in s.get('instances', [])]

    def download(self, instance, dest=None):
        """Download one instance (honouring a member byte range). Returns the local path."""
        dest = Path(dest or self.workdir / f"{instance.get('instanceNumber') or 0:06d}-{instance['sopInstanceUid']}.dcm")
        req = urllib.request.Request(_validated_download_url(instance['url']))
        rng = instance.get('range')
        if rng:
            start = int(rng['start'])
            req.add_header('Range', f"bytes={start}-{start + int(rng['length']) - 1}")
        with urllib.request.urlopen(req, timeout=300) as r, open(dest, 'wb') as f:  # nosec B310 - scheme validated to http(s) by _validated_download_url
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        return dest

    @property
    def upstream(self):
        """Previous pipeline stage's step for this series/study, or None."""
        return self.input.get('upstream')

    @property
    def write_back(self):
        return bool(self.input.get('writeBack'))

    def download_upstream(self, suffix=None):
        """Download the upstream step's outputs (optionally only names ending in suffix)."""
        up = self.upstream or {}
        dest_dir = self.workdir / 'upstream'
        dest_dir.mkdir(exist_ok=True)
        paths = []
        for o in up.get('outputs', []):
            name = o['key'].split('/')[-1]
            if suffix and not name.endswith(suffix):
                continue
            dest = dest_dir / name
            with urllib.request.urlopen(_validated_download_url(o['url']), timeout=300) as r, open(dest, 'wb') as f:  # nosec B310 - scheme validated to http(s) by _validated_download_url
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            paths.append(dest)
        self.metric('upstreamFilesRead', len(paths))
        return paths

    def download_all(self, instances=None):
        paths, failed = [], 0
        for inst in (instances if instances is not None else self.instances):
            try:
                paths.append(self.download(inst))
            except Exception as e:  # noqa: BLE001 - one bad object must not fail the step
                failed += 1
                print(f"download failed for {inst.get('sopInstanceUid')}: {e}", file=sys.stderr)
        self.metric('instancesRead', len(paths))
        if failed:
            self.metric('instancesFailed', failed)
        return paths

    # -- outputs --------------------------------------------------------------
    def put_output(self, name, data, content_type='application/octet-stream', label=None):
        key = 'output/' + name.lstrip('/')
        _s3.put_object(Bucket=_BUCKET, Key=self.base + key, Body=data, ContentType=content_type)
        self._outputs.append({'key': key, 'contentType': content_type, 'label': label or name})
        return key

    def put_file(self, path, name=None, content_type='application/octet-stream', label=None):
        """Upload a local file as an output (streams, so large volumes are fine)."""
        name = name or Path(path).name
        key = 'output/' + name.lstrip('/')
        _s3.upload_file(str(path), _BUCKET, self.base + key, ExtraArgs={'ContentType': content_type})
        self._outputs.append({'key': key, 'contentType': content_type, 'label': label or name})
        return key

    def put_dicom(self, name, data, label=None):
        """A DICOM Part 10 output. Written back to the archive when the run asks for it."""
        return self.put_output(name, data, 'application/dicom', label=label)

    def metric(self, name, value):
        self._metrics[name] = value

    # -- result ---------------------------------------------------------------
    def _write_result(self, status, summary, error=None):
        result = {'status': status, 'summary': summary, 'outputs': self._outputs, 'metrics': self._metrics}
        if error:
            result['error'] = error
        _s3.put_object(Bucket=_BUCKET, Key=self.base + 'result.json',
                       Body=json.dumps(result).encode(), ContentType='application/json')
        self._done = True

    def succeed(self, summary=''):
        self._write_result('SUCCEEDED', summary)

    def skip(self, summary):
        self._write_result('SKIPPED', summary)

    def fail(self, summary):
        self._write_result('FAILED', summary, error=summary)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc is not None:
            print(''.join(traceback.format_exception(exc_type, exc, tb)), file=sys.stderr)
            if not self._done:
                self._write_result('FAILED', f'{exc_type.__name__}: {exc}'[:2000], error=str(exc)[:4000])
            sys.exit(1)
        if not self._done:
            self._write_result('FAILED', 'Plugin finished without reporting a result')
            sys.exit(1)
        return False
