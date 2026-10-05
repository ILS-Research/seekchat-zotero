#!/usr/bin/env python3
"""Publishes the tutorial (docs/tutorial.ipynb, docs/tutorial-en.ipynb) to a downloads directory served by the portal.

    scripts/publish-tutorial.py <downloads-dir>      e.g. ../zotero_selfhost_src/data/downloads

Writes <downloads-dir>/seekchat-tutorial/:
  folien-de.html, slides-en.html            reveal.js slides (the portal shows HTML in a CSP sandbox)
  seekchat-tutorial-de.pdf, -en.pdf         the notebooks as documents
  img/                                      the pictures of the notebooks
  reveal.js/                                local copy of reveal.js and require.js (the sandbox allows no CDN)

Needs jupyter (nbconvert; $JUPYTER, else the ils_env conda env, else jupyter on PATH) and Docker (node:22 fetches
reveal.js and require.js from npm, zenika/alpine-chrome prints the PDFs). Only `docker run --rm` is used.
"""
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

REVEAL = 'reveal.js@4.6.1'
REQUIREJS = 'requirejs@2.1.10'
CHROME = 'zenika/alpine-chrome:latest'
SLIDES = ['--SlidesExporter.reveal_url_prefix=reveal.js', '--SlidesExporter.reveal_scroll=True',
          '--SlidesExporter.reveal_width=1400', '--SlidesExporter.reveal_height=850']
# notebook, slides file, pdf file
OUTPUTS = [('tutorial', 'folien-de.html', 'seekchat-tutorial-de.pdf'),
           ('tutorial-en', 'slides-en.html', 'seekchat-tutorial-en.pdf')]
# What the slides load from the reveal.js package (plus require.js next to it)
REVEAL_FILES = ['dist/reveal.js', 'dist/reveal.css', 'dist/theme/simple.css', 'plugin/notes/notes.js']

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    sys.exit(__doc__)
downloads = Path(sys.argv[1]).resolve()
if not downloads.is_dir():
    sys.exit(f'not a directory: {downloads}')
target = downloads / 'seekchat-tutorial'


def jupyter() -> str:
    for candidate in (os.environ.get('JUPYTER'), '/home/ils_ubuntu/.local/share/mamba/envs/ils_env/bin/jupyter',
                      shutil.which('jupyter')):
        if candidate and Path(candidate).exists():
            return candidate
    sys.exit('jupyter not found: set $JUPYTER')


def run(cmd: list[str], cwd: Path) -> None:
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f'failed: {" ".join(cmd)}\n{result.stdout[-2000:]}{result.stderr[-2000:]}')


def docker(args: list[str], work: Path) -> None:
    run(['docker', 'run', '--rm', '--user', f'{os.getuid()}:{os.getgid()}', '-v', f'{work}:/work', *args], work)


with tempfile.TemporaryDirectory(prefix='seekchat-tutorial-') as tmp:
    work = Path(tmp)
    out = work / 'seekchat-tutorial'
    out.mkdir()
    shutil.copytree(root / 'docs' / 'img', out / 'img')
    for name, _, _ in OUTPUTS:
        shutil.copy(root / 'docs' / f'{name}.ipynb', work)

    # reveal.js and require.js from npm, only the files the slides load
    docker(['-w', '/work', '-e', 'HOME=/tmp', 'node:22', 'npm', 'pack', '--silent', REVEAL, REQUIREJS], work)
    for tgz in work.glob('*.tgz'):
        with tarfile.open(tgz) as tar:
            tar.extractall(work / tgz.stem, filter='data')
    package = lambda prefix: next(p for p in work.glob(f'{prefix}-*') if p.is_dir()) / 'package'
    reveal_pkg = package('reveal.js')
    for rel in REVEAL_FILES:
        (out / 'reveal.js' / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(reveal_pkg / rel, out / 'reveal.js' / rel)
    shutil.copy(package('requirejs') / 'require.js', out / 'reveal.js' / 'require.js')

    nbconvert = [jupyter(), 'nbconvert']
    for name, slides, pdf in OUTPUTS:
        # Slides: require.js from the local copy; jQuery and MathJax are not needed (no widgets, no formulas)
        run([*nbconvert, '--to', 'slides', *SLIDES, f'{name}.ipynb'], work)
        html = (work / f'{name}.slides.html').read_text()
        html = html.replace('https://cdnjs.cloudflare.com/ajax/libs/require.js/2.1.10/require.min.js', 'reveal.js/require.js')
        html = re.sub(r'<script src="https://cdnjs\.cloudflare\.com/ajax/libs/(jquery|mathjax)/[^"]*"[^>]*></script>', '', html)
        if 'cdnjs.cloudflare.com/ajax/libs/require.js' in html:
            sys.exit('nbconvert template changed: require.js still comes from the CDN')
        (out / slides).write_text(html)
        # PDF: the notebook as a document, printed by headless Chrome
        run([*nbconvert, '--to', 'html', '--template', 'classic', f'{name}.ipynb'], work)
        shutil.copytree(out / 'img', work / 'img', dirs_exist_ok=True)
        docker([CHROME, '--no-sandbox', '--headless', '--disable-gpu', '--no-pdf-header-footer',
                f'--print-to-pdf=/work/seekchat-tutorial/{pdf}', f'file:///work/{name}.html'], work)
        if not (out / pdf).stat().st_size:
            sys.exit(f'empty PDF: {pdf}')

    # Replace the published directory in one step
    for p in [out, *out.rglob('*')]:
        p.chmod(0o755 if p.is_dir() else 0o644)
    staged = downloads / '.seekchat-tutorial.new'
    if staged.exists():
        shutil.rmtree(staged)
    shutil.copytree(out, staged)
    if target.exists():
        shutil.rmtree(target)
    staged.rename(target)

files = sorted(p.relative_to(target) for p in target.rglob('*') if p.is_file())
print(f'Published {len(files)} files to {target}:')
for name in ('folien-de.html', 'slides-en.html', 'seekchat-tutorial-de.pdf', 'seekchat-tutorial-en.pdf'):
    print(f'  {name} ({(target / name).stat().st_size // 1024} KB)')
