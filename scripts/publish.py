#!/usr/bin/env python3
"""Publishes the built SeekChat xpi to a downloads directory served by the Zotero portal.

    scripts/publish.py <downloads-dir>      e.g. ../zotero_selfhost_src/data/downloads

Copies dist/seekchat-<version>.xpi (version from package.json) to <downloads-dir>/seekchat/ and
regenerates updates.json there from all seekchat-*.xpi in that directory, so installed plugins
update themselves (installations that came from the portal before 1.0.0rc1). Download links point to
the portal (PORTAL_BASE); the update_url in manifest.json points to gitlab.com (scripts/publish-gitlab.py).
"""
import json
import os
import re
import shutil
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    sys.exit(__doc__)

pkg = json.loads((root / 'package.json').read_text())
manifest = json.loads((root / 'manifest.json').read_text())
zotero = manifest['applications']['zotero']
addon_id = zotero['id']
base_url = os.environ.get('PORTAL_BASE', 'https://zotero.ils.local/downloads/seekchat/')

# Pre-releases: semver in package.json (1.0.0-rc.1), Mozilla's form in the XPI (1.0.0rc1), as in build.mjs.
version = re.sub(r'-([a-z]+)\.?(\d+)$', r'\1\2', pkg['version'])
xpi = root / 'dist' / f'seekchat-{version}.xpi'
if not xpi.is_file():
    sys.exit(f'{xpi} missing, run ./build.sh first')

target = Path(sys.argv[1]).resolve() / 'seekchat'
target.mkdir(parents=True, exist_ok=True)
shutil.copy2(xpi, target / xpi.name)
(target / xpi.name).chmod(0o644)


def version_key(v):
    """1.0.0rc1 < 1.0.0 < 1.0.1 (Mozilla order for these forms)."""
    m = re.fullmatch(r'([\d.]+?)(?:([a-z]+)(\d+))?', v)
    nums = [int(x) for x in m.group(1).split('.')] + [0] * 4
    return (nums[:4], 0 if m.group(2) else 1, int(m.group(3) or 0))


versions = sorted(
    (m.group(1) for f in target.glob('seekchat-*.xpi') if (m := re.fullmatch(r'seekchat-(\d+(?:\.\d+)+(?:[a-z]+\d+)?)\.xpi', f.name))),
    key=version_key,
)
updates = {
    'addons': {
        addon_id: {
            'updates': [
                {
                    'version': v,
                    'update_link': f'{base_url}seekchat-{v}.xpi',
                    'applications': {'zotero': {'strict_min_version': zotero['strict_min_version'],
                                                'strict_max_version': zotero['strict_max_version']}},
                }
                for v in versions
            ]
        }
    }
}
(target / 'updates.json').write_text(json.dumps(updates, indent=2) + '\n')
(target / 'updates.json').chmod(0o644)
print(f'Published {xpi.name} to {target} (versions in updates.json: {", ".join(versions)})')
