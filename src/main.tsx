import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles.css';
import { startAppUpdates } from './platform/update';
import { startViewport } from './platform/viewport';
import { App } from './app/App';

startViewport();

if (import.meta.env.PROD) startAppUpdates();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
