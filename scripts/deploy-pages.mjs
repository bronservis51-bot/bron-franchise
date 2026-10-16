// Публикация статической сборки на GitHub Pages (ADR-0002, вариант «приватный код + публичный репозиторий только со сборкой»).
// Переменные (.env.local): PAGES_REPO — git-адрес публичного репозитория, VITE_BASE_PATH — /<имя-репозитория>/.
// Используются ваши права git (SSH-ключ или credential helper); токены в скрипте не хранятся.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './db-lib.mjs';
import { loadEnv, need } from './env.mjs';

loadEnv();
const repo = need('PAGES_REPO', 'Например git@github.com:<владелец>/bron-pwa-demo.git');
need('VITE_BASE_PATH', 'Например /bron-pwa-demo/');
need('VITE_SUPABASE_URL');
need('VITE_SUPABASE_PUBLISHABLE_KEY');
if (/^sb_secret_/.test(process.env.VITE_SUPABASE_PUBLISHABLE_KEY)) throw new Error('В VITE_SUPABASE_PUBLISHABLE_KEY секретный ключ — публикация остановлена.');

const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });
const version = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
process.env.VITE_APP_VERSION = `0.1.0+${version}`;
run('npm', ['run', 'build']);

const dir = mkdtempSync(join(tmpdir(), 'bron-pages-'));
try {
  cpSync(join(root, 'dist'), dir, { recursive: true });
  writeFileSync(join(dir, '.nojekyll'), '');
  copyFileSync(join(dir, 'index.html'), join(dir, '404.html'));
  run('git', ['init', '-q', '-b', 'gh-pages'], dir);
  run('git', ['add', '-A'], dir);
  run('git', ['-c', 'user.name=Bron deploy', '-c', 'user.email=deploy@localhost', 'commit', '-q', '-m', `Сборка ${version}`], dir);
  run('git', ['push', '--force', repo, 'gh-pages'], dir);
  console.log(`Опубликовано в ${repo} (ветка gh-pages). Включите Pages: Settings → Pages → Branch gh-pages.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
