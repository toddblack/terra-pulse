import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Cesium's widget stylesheet, imported so Vite bundles it like any other CSS.
// `vite-plugin-cesium` used to inject this as a <link> tag pointing into the
// copied asset tree; importing it keeps the styling working without depending
// on that copy having landed, and without a hand-built URL.
import 'cesium/Build/Cesium/Widgets/widgets.css';
import App from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
