import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const PRODUCTION_API = 'https://api.bronservis.ru';
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2000;
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
const MIGRATION = /^(?:[0-9]{4}|[0-9]{14})_[a-z0-9_-]+\.sql$/;
const SITE_MANIFEST = 'site/release-manifest.json';

function requireSite(staging, files) {
  for (const entry of ['index.html', 'manifest.webmanifest', 'app-version.json', 'sw.js']) {
    if (!files.has(`site/${entry}`)) throw new Error(`Missing built site file ${entry}`);
  }
  const html = readFileSync(join(staging, 'site/index.html'), 'utf8');
  const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1];
  const connectSources = policy?.split(';').map(rule => rule.trim().split(/\s+/)).find(([name]) => name === 'connect-src');
  if (!connectSources?.includes(PRODUCTION_API)) throw new Error(`Built site must use production API ${PRODUCTION_API}`);
  const webManifest = JSON.parse(readFileSync(join(staging, 'site/manifest.webmanifest'), 'utf8'));
  if (webManifest.start_url !== '/' || webManifest.scope !== '/' || !/<script\b[^>]*\bsrc="\/assets\//i.test(html)) {
    throw new Error('Built site must use the root base path');
  }
  if (![...files.keys()].some(entry => entry.startsWith('site/assets/'))) throw new Error('Missing built assets');
  const version = JSON.parse(readFileSync(join(staging, 'site/app-version.json'), 'utf8'));
  if (typeof version.build !== 'string' || !Number.isFinite(Date.parse(version.build))) throw new Error('Invalid built site version');
  return version.build;
}

function buildBundle({ source, 'expected-live': expected, site, migrations, output }) {
  if (!SHA.test(source ?? '') || !SHA.test(expected ?? '')) throw new Error('Both revision IDs must be full 40 lowercase hex commits');
  if (!site || !migrations || !output) throw new Error('--site, --migrations and --output are required');
  const staging = mkdtempSync(join(tmpdir(), 'bron-release-bundle-'));
  const files = new Map();
  let totalBytes = 0;

  function recordFile(entry, content) {
    files.set(entry, { bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }

  function copyTree(from, entry) {
    const info = lstatSync(from);
    if (info.isDirectory() && (entry === 'migrations' || entry === 'site' || entry.startsWith('site/'))) {
      mkdirSync(join(staging, entry));
      for (const name of readdirSync(from).sort()) {
        if (!NAME.test(name)) throw new Error(`Unsupported path name ${entry}/${name}`);
        copyTree(join(from, name), `${entry}/${name}`);
      }
      return;
    }
    if (!info.isFile() || entry === 'site' || entry === 'migrations') throw new Error(`Expected a regular file or built directory at ${entry}`);
    if (entry.startsWith('migrations/') && !MIGRATION.test(entry.slice('migrations/'.length))) {
      throw new Error(`Unexpected migration filename ${entry}`);
    }
    totalBytes += info.size;
    if (totalBytes >= MAX_ARCHIVE_BYTES) throw new Error('Release bundle exceeds 64 MiB');
    const destination = join(staging, entry);
    copyFileSync(from, destination, constants.COPYFILE_EXCL);
    recordFile(entry, readFileSync(destination));
  }

  try {
    copyTree(resolve(site), 'site');
    const buildTime = requireSite(staging, files);
    if (files.has(SITE_MANIFEST)) throw new Error('The built site already contains a release manifest');
    const siteManifest = { format: 1, kind: 'app', sourceCommit: source, base: '/', apiOrigin: PRODUCTION_API, buildTime,
      files: [...files.keys()].sort().map(entry => ({ file: entry.slice('site/'.length), ...files.get(entry) })) };
    const siteManifestText = Buffer.from(`${JSON.stringify(siteManifest, null, 2)}\n`);
    writeFileSync(join(staging, SITE_MANIFEST), siteManifestText, { flag: 'wx' });
    recordFile(SITE_MANIFEST, siteManifestText);
    copyTree(resolve(migrations), 'migrations');
    if (![...files.keys()].some(entry => entry.startsWith('migrations/'))) throw new Error('Missing migration history');
    const paths = [...files.keys()].sort();
    if (paths.length + 1 > MAX_ARCHIVE_ENTRIES) throw new Error('Release bundle has too many files');
    const manifest = { format_version: 1, source_sha: source, expected_live_source_sha: expected,
      files: Object.fromEntries(paths.map(entry => [entry, files.get(entry).sha256])) };
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    const archive = join(staging, 'bundle.tar');
    execFileSync('tar', ['--format=ustar', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '-cf', archive, '-C', staging, '--', 'manifest.json', ...paths]);
    if (lstatSync(archive).size > MAX_ARCHIVE_BYTES) throw new Error('Release bundle exceeds 64 MiB');
    const target = resolve(output);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(archive, target, constants.COPYFILE_EXCL);
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

try {
  const { values } = parseArgs({ options: {
    source: { type: 'string' }, 'expected-live': { type: 'string' }, site: { type: 'string' },
    migrations: { type: 'string' }, output: { type: 'string' },
  } });
  buildBundle(values);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
