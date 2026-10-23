import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
document.documentElement.dataset.theme = systemTheme;
document.documentElement.style.colorScheme = systemTheme;

const root = document.getElementById('root');
if (!root) throw new Error('Notion Tasks renderer root is missing.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
