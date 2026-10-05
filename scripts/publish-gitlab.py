#!/usr/bin/env python3
"""Adds the version from package.json to updates.json in the repository root (where installed plugins look for updates,
manifest.json update_url). The release itself comes from the gitlab.com CI on the tag v<version> (.gitlab-ci.yml, job
"release"): it uploads the xpi to the generic package registry at the URL linked here and creates the release.

    scripts/publish-gitlab.py      then commit updates.json, push master and the tag to remote "gitlab"
"""
import json
import re
from pathlib import Path

# gitlab.com project id of ils-research/zotero-plugins/seekchat-zotero.
PACKAGES = 'https://gitlab.com/api/v4/projects/87216794/packages/generic/seekchat'

root = Path(__file__).resolve().parent.parent
pkg = json.loads((root / 'package.json').read_text())
zotero = json.loads((root / 'manifest.json').read_text())['applications']['zotero']
# Pre-releases: semver in package.json (1.0.0-rc.1), Mozilla's form in the XPI (1.0.0rc1), as in build.mjs.
version = re.sub(r'-([a-z]+)\.?(\d+)$', r'\1\2', pkg['version'])


def version_key(v):
    """1.0.0rc1 < 1.0.0 < 1.0.1 (Mozilla order for these forms)."""
    m = re.fullmatch(r'([\d.]+?)(?:([a-z]+)(\d+))?', v)
    nums = [int(x) for x in m.group(1).split('.')] + [0] * 4
    return (nums[:4], 0 if m.group(2) else 1, int(m.group(3) or 0))


path = root / 'updates.json'
updates = json.loads(path.read_text()) if path.is_file() else {'addons': {zotero['id']: {'updates': []}}}
entries = [u for u in updates['addons'][zotero['id']]['updates'] if u['version'] != version]
entries.append({
    'version': version,
    'update_link': f'{PACKAGES}/{version}/seekchat-{version}.xpi',
    'applications': {'zotero': {'strict_min_version': zotero['strict_min_version'], 'strict_max_version': zotero['strict_max_version']}},
})
entries.sort(key=lambda u: version_key(u['version']))
updates['addons'][zotero['id']]['updates'] = entries
path.write_text(json.dumps(updates, indent=2) + '\n')
print(f'updates.json: {", ".join(u["version"] for u in entries)}')
