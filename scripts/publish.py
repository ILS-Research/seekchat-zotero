#!/usr/bin/env python3
"""Points the portal at the gitlab.com releases (the portal no longer mirrors the xpi files).

    scripts/publish.py <downloads-dir>      e.g. ../zotero_selfhost_src/data/downloads

Copies updates.json from the repository root (written by scripts/publish-gitlab.py, links to the xpi in gitlab.com's
package registry) to <downloads-dir>/seekchat/updates.json. Installations from before 1.0.0rc1 still look for updates
there; they get the newest gitlab.com release and from then on update from gitlab.com themselves. The download page
links to gitlab.com's "latest release" permalink, so nothing else has to be published.
"""
import shutil
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    sys.exit(__doc__)
source = root / 'updates.json'
if not source.is_file():
    sys.exit(f'{source} missing, run scripts/publish-gitlab.py first')
target = Path(sys.argv[1]).resolve() / 'seekchat'
target.mkdir(parents=True, exist_ok=True)
shutil.copy2(source, target / 'updates.json')
(target / 'updates.json').chmod(0o644)
print(f'{target / "updates.json"} now lists the gitlab.com releases')
