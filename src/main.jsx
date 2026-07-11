import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App.jsx';
import './app/app.css';
import { createAppServices } from './app/create-app-services.js';

const root = document.getElementById('root');

if (!root) throw new Error('KS2 Spelling root element is missing.');

createRoot(root).render(
  <StrictMode>
    <App services={createAppServices()} />
  </StrictMode>,
);
