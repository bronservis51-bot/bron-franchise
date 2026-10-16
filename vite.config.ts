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
    `img-src 'self' data: blob: ${origin}`.trim(), `connect-src 'self' ${origin} ${ws}`.trim(),
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
  return {
    base,
    plugins: [
      react(),
      cspPlugin(env.VITE_SUPABASE_URL ?? ''),
      VitePWA({
        registerType: 'autoUpdate', // новая версия ставится сама: черновики хранятся в IndexedDB и переживают перезагрузку (PWA-06)
        injectRegister: false,
        includeAssets: ['icons/*.svg', 'icons/*.png'],
        manifest: {
          name: 'Бронь Сервис — рабочий кабинет',
          short_name: 'Бронь Сервис',
          description: 'Корпоративная платформа: задачи, открытия, поддержка, заказы, роялти и знания',
          lang: 'ru',
          start_url: base,
          scope: base,
          display: 'standalone',
          background_color: '#0f0f11',
          theme_color: '#0f0f11',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // Кешируется только оболочка приложения; данные API и файлы не кешируются (PWA-05)
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          navigateFallback: `${base}index.html`,
          runtimeCaching: [],
          cleanupOutdatedCaches: true,
          skipWaiting: true,
          clientsClaim: true,
        },
      }),
    ],
    build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
  };
});
