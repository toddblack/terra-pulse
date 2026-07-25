import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  // build.externalizeDeps defaults to true — main/preload dependencies are
  // externalized (required via Electron's Node runtime) rather than bundled.
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react(), cesium()],
  },
});
