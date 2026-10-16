import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles.css';
import './platform/i18n';
import { registerSW } from 'virtual:pwa-register';
import { App } from './app/App';

// Обновление приложения: проверка при запуске (в т. ч. на странице входа) и каждые 30 минут; новая версия применяется сама
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const update = registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) { if (reg) setInterval(() => void reg.update(), 30 * 60 * 1000); },
  });
  void update;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
