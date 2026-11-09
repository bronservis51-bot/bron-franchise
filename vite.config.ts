import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import type { Plugin } from 'vite';

/** CSP через meta (GitHub Pages не задаёт заголовки): сеть разрешена только к собственному проекту Supabase (ADR-0003). */
function cspPlugin(supabaseUrl: string): Plugin {
  let origin = '';
  try {
    origin = new URL(supabaseUrl).origin;
  } catch {
    origin = '';
  }
  const ws = origin.replace(/^http/, 'ws');
  const csp = [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    // картинки статей — по https-ссылкам; видео — только встроенные плееры YouTube, Rutube и VK
    `img-src 'self' data: blob: https: ${origin}`.trim(), `connect-src 'self' ${origin} ${ws} https://api.github.com`.trim(),
    'frame-src https://www.youtube-nocookie.com https://rutube.ru https://vk.com https://vkvideo.ru',
    "worker-src 'self'", "manifest-src 'self'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ].join('; ');
  return {
    name: 'bron-csp',
    transformIndexHtml(html, ctx) {
      // В режиме разработки Vite внедряет inline-скрипты HMR — CSP добавляется только в сборку
      if (ctx.server) return html;
      return html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    },
  };
}

// Сборка работает в подкаталоге GitHub Pages (COST-16): base, start_url и scope — из VITE_BASE_PATH.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const base = env.VITE_BASE_PATH || '/';
  const buildTime = new Date().toISOString();
  return {
    base,
    server: { allowedHosts: ['terminal.local'] }, // exact internal browser QA host; production build is unaffected
    plugins: [
      react(),
      { name: 'bron-release-version', generateBundle() { this.emitFile({ type: 'asset', fileName: 'app-version.json', source: JSON.stringify({ build: buildTime }) }); } },
      cspPlugin(env.VITE_SUPABASE_URL ?? ''),
      VitePWA({
        registerType: 'prompt', // activation and safe page reload are separate (platform/update.ts)
        injectRegister: false,
        includeAssets: ['icons/*.svg', 'icons/*.png'],
        manifest: {
          name: 'Бронь Сервис — кабинет франчайзи',
          short_name: 'Бронь Сервис',
          description: 'Кабинет франчайзи: база знаний, выручка за день и план на месяц',
          lang: 'ru',
          start_url: base,
          scope: base,
          display: 'standalone',
          background_color: '#0f0f11',
          theme_color: '#2f5cff',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // Кешируется только оболочка приложения; данные API и файлы не кешируются (PWA-05)
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          navigateFallback: null,
          // Navigation must prefer the network so a phone does not keep an old cached login.
          runtimeCaching: [{
            urlPattern: ({ request }) => request.mode === 'navigate', handler: 'NetworkFirst',
            options: { cacheName: 'bron-navigation-v2', networkTimeoutSeconds: 3, fetchOptions: { cache: 'no-store' },
              cacheableResponse: { statuses: [200] }, precacheFallback: { fallbackURL: `${base}index.html` } },
          }],
          cleanupOutdatedCaches: true,
          skipWaiting: true, // unblocks old workers; page reload still requires the client safety guard
          clientsClaim: false,
        },
      }),
    ],
    // Время сборки — на странице входа, чтобы видеть, открыта ли свежая версия
    define: { 'import.meta.env.VITE_BUILD_TIME': JSON.stringify(buildTime) },
    build: {
      target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900,
      // Стабильные библиотеки не скачиваются заново при каждой правке интерфейса.
      rolldownOptions: { input: { main:'index.html', help:'help.html' }, output: { codeSplitting: { groups: [
        { name: 'vendor-react', test: /node_modules\/(react|react-dom|scheduler|react-router|@tanstack)\// },
        { name: 'vendor-backend', test: /node_modules\/@supabase\// },
      ] } } },
    },
  };
});
