"""DICOM to NIfTI as a processing-job plugin (dcm2niix).

The plugin port of cdk-infrastructure/lib/nifti/container/convert.py. Same
dcm2niix invocation and output grouping, but through the plugin contract: the
instances arrive as presigned URLs in input.json and the volumes are step
outputs, so the container needs no database access and no archive IAM.

Parameters (declared in the manifest):
  sidecarMode        enum     anonymized | full | none
  compress           boolean  .nii.gz instead of .nii
  ignoreDerived      boolean  dcm2niix -i y
  skipNonVolumetric  boolean  skip SR/PR/KO/AU/SM/DOC series without converting
"""
import shutil
import subprocess
from pathlib import Path

from plugin_sdk import Step

NON_VOLUMETRIC_MODALITIES = {'SR', 'PR', 'KO', 'AU', 'SM', 'DOC'}
COMPANIONS = (('.json', 'BIDS sidecar', 'application/json'),
              ('.bval', 'b-values', 'text/plain'),
              ('.bvec', 'b-vectors', 'text/plain'))


def truthy(value, default):
    if value is None or value == '':
        return default
    return value is True or str(value).lower() in ('true', 'yes', '1', 'y')


def converter_version():
    try:
        r = subprocess.run(['dcm2niix', '--version'], capture_output=True, text=True, timeout=30)  # nosec B603 -- static argv list, no shell, no user-controlled command
        return (r.stdout or r.stderr).strip().splitlines()[-1][:128]
    except Exception:  # noqa: BLE001
        return 'unknown'


def run_dcm2niix(input_dir, output_dir, params):
    sidecar = params.get('sidecarMode') or 'anonymized'
    args = [
        'dcm2niix',
        '-z', 'y' if truthy(params.get('compress'), True) else 'n',
        # ProtocolName_SeriesNumber; dcm2niix adds its own suffixes (_e2, _ph,
        # _i00002) when it splits a series, so one series can give several files.
        '-f', '%p_%s',
        '-o', str(output_dir),
    ]
    if sidecar == 'none':
        args += ['-b', 'n']
    else:
        # -ba y strips patient identifiers from the sidecar.
        args += ['-b', 'y', '-ba', 'n' if sidecar == 'full' else 'y']
    if truthy(params.get('ignoreDerived'), False):
        args += ['-i', 'y']
    args.append(str(input_dir))
    print('Running: ' + ' '.join(args))
    r = subprocess.run(args, capture_output=True, text=True, timeout=3600)  # nosec B603 # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit -- fixed dcm2niix argv built from allowlisted flags, no shell (audited)
    log = (r.stdout or '') + (r.stderr or '')
    print(log)
    return r.returncode, log


def decompress_all(input_dir, raw_dir):
    """Rewrite every instance as uncompressed Explicit VR Little Endian (gdcmconv -w).

    The Debian dcm2niix build has no JPEG-LS (and no HTJ2K) decoder, so a series
    stored that way converts to nothing. GDCM decodes them; a file it cannot
    rewrite is copied unchanged so dcm2niix still sees it.
    """
    raw_dir.mkdir()
    converted = 0
    for src in sorted(input_dir.iterdir()):
        dst = raw_dir / src.name
        r = subprocess.run(['gdcmconv', '-w', str(src), str(dst)], capture_output=True, text=True, timeout=600)  # nosec B603 -- static argv list, no shell, no user-controlled command
        if r.returncode == 0 and dst.exists():
            converted += 1
        else:
            shutil.copyfile(src, dst)
    return converted


def volumes(output_dir):
    vols = sorted(list(output_dir.glob('*.nii.gz')) + list(output_dir.glob('*.nii')))
    for v in vols:
        stem = v.name[:-7] if v.name.endswith('.nii.gz') else v.stem
        yield v, [(output_dir / f'{stem}{suffix}', label, ctype)
                  for suffix, label, ctype in COMPANIONS if (output_dir / f'{stem}{suffix}').exists()]


def main():
    with Step() as step:
        modality = (step.input.get('modality') or '').upper()
        if truthy(step.params.get('skipNonVolumetric'), True) and modality in NON_VOLUMETRIC_MODALITIES:
            step.skip(f'{modality} series carry no volume to convert')
            return
        if not step.instances:
            step.skip('Series has no readable instances')
            return

        input_dir = step.workdir / 'dicom'
        output_dir = step.workdir / 'nifti'
        input_dir.mkdir()
        output_dir.mkdir()
        paths = [step.download(i, input_dir / f"{n:06d}.dcm") for n, i in enumerate(step.instances)]
        step.metric('instancesRead', len(paths))
        step.metric('converter', converter_version())

        code, log = run_dcm2niix(input_dir, output_dir, step.params)
        produced = list(volumes(Path(output_dir)))
        if not produced and 'Unsupported transfer syntax' in log:
            raw_dir = step.workdir / 'dicom-raw'
            n = decompress_all(input_dir, raw_dir)
            step.metric('decompressedForConversion', n)
            code, log2 = run_dcm2niix(raw_dir, output_dir, step.params)
            log += log2
            produced = list(volumes(Path(output_dir)))
        if not produced:
            step.fail(f'dcm2niix produced no volume (exit {code}). {log[-1500:]}')
            return

        total = 0
        for vol, companions in produced:
            ctype = 'application/gzip' if vol.name.endswith('.gz') else 'application/octet-stream'
            step.put_file(vol, content_type=ctype, label=f'NIfTI volume {vol.name}')
            total += vol.stat().st_size
            for path, label, comp_type in companions:
                step.put_file(path, content_type=comp_type, label=f'{label} for {vol.name}')
        step.metric('volumes', len(produced))
        step.metric('outputBytes', total)
        step.succeed(f'{len(produced)} volume(s) from {len(paths)} instances ({total / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
