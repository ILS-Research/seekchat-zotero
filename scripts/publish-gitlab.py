#!/usr/bin/env python3
"""Publishes the built SeekChat xpi as a release on gitlab.com, where installed plugins look for updates.

    GITLAB_TOKEN=<token with api scope> scripts/publish-gitlab.py

The tag v<version> (version from package.json) must already be pushed to the gitlab.com remote. The script
1. uploads dist/seekchat-<xpi version>.xpi to the project's generic package registry,
2. creates the release for the tag (text: the version's CHANGELOG section, asset link: the xpi),
3. adds the version to updates.json in the repository root.
Then commit updates.json and push master to gitlab.com: manifest.json's update_url is that file's raw URL.
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT = 'ils-research/zotero-plugins/seekchat-zotero'
API = f'https://gitlab.com/api/v4/projects/{urllib.parse.quote(PROJECT, safe="")}'

root = Path(__file__).resolve().parent.parent
token = os.environ.get('GITLAB_TOKEN', '')
if not token:
    sys.exit(__doc__)

pkg = json.loads((root / 'package.json').read_text())
manifest = json.loads((root / 'manifest.json').read_text())
zotero = manifest['applications']['zotero']
semver = pkg['version']
# Pre-releases: semver in package.json (1.0.0-rc.1), Mozilla's form in the XPI (1.0.0rc1), as in build.mjs.
version = re.sub(r'-([a-z]+)\.?(\d+)$', r'\1\2', semver)
tag = f'v{semver}'
xpi = root / 'dist' / f'seekchat-{version}.xpi'
if not xpi.is_file():
    sys.exit(f'{xpi} missing, run ./build.sh first')


def call(method, url, data=None, content_type='application/json'):
    req = urllib.request.Request(url, data=data, method=method, headers={'PRIVATE-TOKEN': token, 'Content-Type': content_type})
    with urllib.request.urlopen(req) as resp:
        body = resp.read()
        return json.loads(body) if body else None


package_url = f'{API}/packages/generic/seekchat/{version}/{xpi.name}'
call('PUT', package_url, xpi.read_bytes(), 'application/octet-stream')
print(f'uploaded {xpi.name}')

changelog = (root / 'CHANGELOG.md').read_text()
m = re.search(rf'^## {re.escape(semver)} .*?\n(.*?)(?=^## |\Z)', changelog, re.S | re.M)
call('POST', f'{API}/releases', json.dumps({
    'tag_name': tag,
    'name': f'SeekChat {version}',
    'description': (m.group(1).strip() if m else ''),
    'assets': {'links': [{'name': xpi.name, 'url': package_url, 'link_type': 'package'}]},
}).encode())
print(f'release {tag} created')


def version_key(v):
    """1.0.0rc1 < 1.0.0 < 1.0.1 (Mozilla order for these forms)."""
    mm = re.fullmatch(r'([\d.]+?)(?:([a-z]+)(\d+))?', v)
    nums = [int(x) for x in mm.group(1).split('.')] + [0] * 4
    return (nums[:4], 0 if mm.group(2) else 1, int(mm.group(3) or 0))


updates_file = root / 'updates.json'
updates = json.loads(updates_file.read_text()) if updates_file.is_file() else {'addons': {zotero['id']: {'updates': []}}}
entries = [u for u in updates['addons'][zotero['id']]['updates'] if u['version'] != version]
entries.append({
    'version': version,
    'update_link': package_url,
    'applications': {'zotero': {'strict_min_version': zotero['strict_min_version'], 'strict_max_version': zotero['strict_max_version']}},
})
entries.sort(key=lambda u: version_key(u['version']))
updates['addons'][zotero['id']]['updates'] = entries
updates_file.write_text(json.dumps(updates, indent=2) + '\n')
print(f'updates.json: {", ".join(u["version"] for u in entries)} – commit it and push master to gitlab.com')
