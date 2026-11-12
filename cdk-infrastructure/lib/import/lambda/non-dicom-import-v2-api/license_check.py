#!/usr/bin/env python3
"""Build-time licence gate for a Lambda bundle (stdlib only, no network).

Usage: license_check.py <dir-with-installed-packages> [--notices OUT]

Walks every *.dist-info/METADATA under the directory and exits 1 if any
distribution declares a GPL, LGPL or AGPL licence (License-Expression,
License or a "License ::" classifier). With --notices it writes a
THIRD-PARTY-NOTICES file listing every distribution, its version and licence.
Run by the CDK bundling command after `pip install -t /asset-output`.
"""
import email.parser
import pathlib
import re
import sys

DENY = re.compile(r'\b(A|L)?GPL\b|GNU (Affero |Lesser |Library )?General Public', re.IGNORECASE)


def copyleft_only(expr):
    if not DENY.search(expr):
        return False
    return all(DENY.search(p) for p in re.split(r'\s+OR\s+', expr))


def licences(meta):
    out = []
    expr = meta.get('License-Expression')
    if expr:
        out.append(expr.strip())
    lic = meta.get('License')
    if lic and lic.strip() and lic.strip().upper() != 'UNKNOWN' and len(lic) < 200:
        out.append(lic.strip())
    for c in meta.get_all('Classifier') or []:
        if c.startswith('License ::'):
            out.append(c.split('::')[-1].strip())
    return out


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    root = pathlib.Path(argv[1])
    notices = argv[argv.index('--notices') + 1] if '--notices' in argv else None
    rows, bad = [], []
    for meta_path in sorted(root.glob('*.dist-info/METADATA')):
        meta = email.parser.Parser().parsestr(meta_path.read_text(encoding='utf-8', errors='replace'))
        lic = licences(meta)
        name, version = meta.get('Name', meta_path.parent.name), meta.get('Version', '?')
        rows.append((name, version, '; '.join(dict.fromkeys(lic)) or 'UNKNOWN'))
        # A dual licence expression such as "Apache-2.0 OR BSD-3-Clause" is
        # judged by its alternatives: it fails only when every alternative is
        # copyleft. Any other copyleft declaration fails the gate.
        if any(copyleft_only(x) for x in lic):
            bad.append((name, version, lic))
    for name, version, lic in rows:
        print(f'{name}=={version}: {lic}')
    if notices:
        with open(notices, 'w', encoding='utf-8') as fh:
            fh.write('THIRD-PARTY-NOTICES\n\nThis bundle includes the following third-party packages:\n\n')
            for name, version, lic in rows:
                fh.write(f'{name} {version}\n  License: {lic}\n\n')
    if bad:
        for name, version, lic in bad:
            print(f'LICENCE GATE: {name}=={version} is copyleft ({lic})', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
