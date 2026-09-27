#!/usr/bin/env python3
"""Publishes the built SeekChat xpi to a downloads directory served by the Zotero portal.

    scripts/publish.py <downloads-dir>      e.g. ../zotero_seflhost_src/data/downloads

Copies dist/seekchat-<version>.xpi (version from package.json) to <downloads-dir>/seekchat/ and
regenerates updates.json there from all seekchat-*.xpi in that directory, so installed plugins
update themselves. The download URL is derived from update_url in manifest.json, which must point
to <portal>/downloads/seekchat/updates.json.
"""
import json
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
update_url = zotero['update_url']
if not update_url.endswith('/updates.json'):
    sys.exit(f'update_url must end with /updates.json: {update_url}')
base_url = update_url[: -len('updates.json')]

version = pkg['version']
xpi = root / 'dist' / f'seekchat-{version}.xpi'
if not xpi.is_file():
    sys.exit(f'{xpi} missing, run ./build.sh first')

target = Path(sys.argv[1]).resolve() / 'seekchat'
target.mkdir(parents=True, exist_ok=True)
shutil.copy2(xpi, target / xpi.name)
(target / xpi.name).chmod(0o644)


def version_key(v):
    return [int(x) for x in v.split('.')]


versions = sorted(
    (m.group(1) for f in target.glob('seekchat-*.xpi') if (m := re.fullmatch(r'seekchat-(\d+(?:\.\d+)+)\.xpi', f.name))),
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
