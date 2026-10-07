// Bundles src/ with esbuild and assembles the plugin in build/.
// `--pack` additionally zips build/ into dist/seekchatzot-<version>.xpi.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, process.argv.includes('--e2e') ? 'build-e2e' : 'build');
const pack = process.argv.includes('--pack');
// E2E variant: bundles the test harness (test/e2e/) in; never ship it.
const e2e = process.argv.includes('--e2e');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });

for (const dir of ['content', 'locale']) {
  fs.cpSync(path.join(root, dir), path.join(buildDir, dir), { recursive: true });
}
for (const file of ['bootstrap.js', 'prefs.js']) {
  fs.copyFileSync(path.join(root, file), path.join(buildDir, file));
}
// package.json is the single source of the version. Pre-releases are semver there (1.0.0-rc.1) and take Mozilla's
// form in the XPI (1.0.0rc1, sorts before 1.0.0).
const version = pkg.version.replace(/-([a-z]+)\.?(\d+)$/, '$1$2');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
manifest.version = version;
if (e2e) manifest.name += ' (E2E)';
fs.writeFileSync(path.join(buildDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

await esbuild.build({
  entryPoints: [path.join(root, e2e ? 'test/e2e/entry.ts' : 'src/index.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['firefox128'],
  outfile: path.join(buildDir, 'content/scripts/seekchat.js'),
  logLevel: 'info',
});

if (pack) {
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const xpi = path.join(distDir, `seekchatzot-${version}${e2e ? '-e2e' : ''}.xpi`);
  fs.rmSync(xpi, { force: true });
  execFileSync('zip', ['-qr', xpi, '.'], { cwd: buildDir, stdio: 'inherit' });
  console.log(`Packed ${path.relative(root, xpi)}`);
}
