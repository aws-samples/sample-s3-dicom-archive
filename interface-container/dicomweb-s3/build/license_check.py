"""Build-time licence gate: exit 1 if any installed distribution is GPL-family.

The shipped image must not contain copyleft (GPL, LGPL, AGPL) packages. Reads
each distribution's License-Expression, License and classifier metadata; a
package whose metadata names a GPL-family licence fails the build, listed by
name so the fix is obvious. Not part of the service: the Dockerfile copies
it to /tmp, runs it and deletes it, and `COPY *.py` does not reach build/.
"""
import re
import sys
from importlib import metadata

# Word-bounded so "GPL" inside an unrelated token does not match.
COPYLEFT = re.compile(r'\b(A|L)?GPL(v?\d)?\b|GNU (Affero |Lesser |Library )?General Public', re.I)
# The interpreter's own pip/setuptools/wheel are tooling, not shipped code, and
# none is GPL; listed only so the intent is explicit if their metadata changes.
IGNORE = {'pip', 'setuptools', 'wheel'}


def licence_strings(dist):
    md = dist.metadata
    out = [md.get('License-Expression') or '', (md.get('License') or '')[:300]]
    out += [c for c in (md.get_all('Classifier') or []) if c.startswith('License ::')]
    return [s for s in out if s]


def main():
    bad = []
    for dist in metadata.distributions():
        name = (dist.metadata.get('Name') or '').lower()
        if name in IGNORE:
            continue
        hits = [s for s in licence_strings(dist) if COPYLEFT.search(s)]
        if hits:
            bad.append(f"{dist.metadata.get('Name')} {dist.version}: {'; '.join(hits)}")
    if bad:
        print('Copyleft-licensed packages are not allowed in this image:', file=sys.stderr)
        for line in sorted(set(bad)):
            print('  ' + line, file=sys.stderr)
        return 1
    print('license_check: no GPL-family packages installed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
