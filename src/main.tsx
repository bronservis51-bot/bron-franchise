import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles.css';
import { registerSW } from 'virtual:pwa-register';
import { setAvailableUpdate } from './platform/update';
import { App } from './app/App';

// Установка оболочки после первого отображения: precache не конкурирует с загрузкой экрана и API.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const register = () => {
    const update = registerSW({
      immediate: true,
      onNeedRefresh() { setAvailableUpdate(() => update(true)); },
      onRegisteredSW(_url, reg) {
        if (reg) setInterval(() => { if (navigator.onLine && document.visibilityState === 'visible') void reg.update(); }, 30 * 60 * 1000);
      },
    });
  };
  const schedule = () => { if ('requestIdleCallback' in window) window.requestIdleCallback(register, { timeout: 5000 }); else setTimeout(register, 1000); };
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
