import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const script = fileURLToPath(new URL('../../scripts/build-release-bundle.mjs', import.meta.url));
const source = '3'.repeat(40);
const expected = '2'.repeat(40);

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bron-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const site = join(directory, 'dist');
  const migrations = join(directory, 'migrations');
  const output = join(directory, 'release.tar');
  mkdirSync(join(site, 'assets'), { recursive: true });
  mkdirSync(migrations);
  const html = '<meta http-equiv="Content-Security-Policy" content="connect-src \'self\' https://api.bronservis.ru"><script src="/assets/main.js"></script>\n';
  writeFileSync(join(site, 'index.html'), html);
  writeFileSync(join(site, 'app-version.json'), '{"build":"2026-11-19T01:00:00.000Z"}\n');
  writeFileSync(join(site, 'sw.js'), '// test worker\n');
  writeFileSync(join(site, 'manifest.webmanifest'), '{"start_url":"/","scope":"/"}\n');
  writeFileSync(join(site, 'assets/main.js'), 'console.log("build");\n');
  writeFileSync(join(migrations, '0001_initial.sql'), 'select 1;\n');
  writeFileSync(join(migrations, '20261119010000_release.sql'), 'select 2;\n');
  const build = (sha = source) => spawnSync(process.execPath, [script, '--source', sha, '--expected-live', expected, '--site', site, '--migrations', migrations, '--output', output], { encoding: 'utf8' });
  return { site, migrations, html, output, build };
}

test('packs the full migration history and a file checksum manifest', (t) => {
  const { build, output } = setup(t);
  const result = build();
  assert.equal(result.status, 0, result.stderr);
  const read = (entry) => execFileSync('tar', ['-xOf', output, entry]);
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(Object.keys(manifest), ['format_version', 'source_sha', 'expected_live_source_sha', 'files']);
  assert.equal(manifest.format_version, 1);
  assert.equal(manifest.source_sha, source);
  assert.equal(manifest.expected_live_source_sha, expected);
  assert.equal(manifest.files['migrations/0001_initial.sql'], createHash('sha256').update('select 1;\n').digest('hex'));
  assert.equal(manifest.files['migrations/20261119010000_release.sql'], createHash('sha256').update('select 2;\n').digest('hex'));
  const publicSite = JSON.parse(read('site/release-manifest.json'));
  assert.equal(publicSite.sourceCommit, source);
  assert.equal(publicSite.apiOrigin, 'https://api.bronservis.ru');
  assert.equal(publicSite.base, '/');
  assert.equal(publicSite.buildTime, '2026-11-19T01:00:00.000Z');
  const appPaths = Object.keys(manifest.files).filter((entry) => entry.startsWith('site/') && entry !== 'site/release-manifest.json');
  assert.deepEqual(publicSite.files, appPaths.map((entry) => ({
    file: entry.slice('site/'.length), bytes: read(entry).length, sha256: manifest.files[entry],
  })));
  const regularFiles = execFileSync('tar', ['-tf', output], { encoding: 'utf8' }).trim().split('\n').filter((entry) => !entry.endsWith('/') && entry !== 'manifest.json').sort();
  assert.deepEqual(Object.keys(manifest.files), regularFiles);
  for (const [entry, checksum] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(read(entry)).digest('hex'), checksum);
});

test('rejects an app manifest with a nonroot scope', (t) => {
  const { site, build, output } = setup(t);
  writeFileSync(join(site, 'manifest.webmanifest'), '{"start_url":"/","scope":"/nested/"}');
  const result = build();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /root base path/);
  assert.equal(existsSync(output), false);
});

test('rejects a short source SHA before creating the package', (t) => {
  const { build, output } = setup(t);
  const result = build('abcd');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /40 lowercase hex/);
  assert.equal(existsSync(output), false);
});

test('rejects a release pointing to a different backend', (t) => {
  const { site, html, build, output } = setup(t);
  writeFileSync(join(site, 'index.html'), html.replace('api.bronservis.ru', 'other.example'));
  const result = build();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /production API/);
  assert.equal(existsSync(output), false);
});

test('refuses symlinks and files outside the migration naming contract', (t) => {
  const { site, migrations, build, output } = setup(t);
  const link = join(site, 'outside.js');
  symlinkSync(join(migrations, '0001_initial.sql'), link);
  let result = build();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /regular file|directory/);
  assert.equal(existsSync(output), false);
  rmSync(link);
  writeFileSync(join(migrations, 'helper.sh'), '# ignored by normal tooling\n');
  result = build();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /migration filename/);
  assert.equal(existsSync(output), false);
});
