import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  // build.externalizeDeps defaults to true — main/preload dependencies are
  // externalized (required via Electron's Node runtime) rather than bundled.
  // That's correct for real npm packages (dotenv, electron), which ship
  // compiled .js — but our own workspace packages ship raw .ts source with
  // no build step, which Node's actual runtime ESM loader can't resolve at
  // all. Excluding them here means Vite bundles/inlines their source instead
  // of leaving them as runtime imports. node:sqlite stays externalized
  // regardless — Node built-ins are handled separately from this option.
  main: {
    build: {
      externalizeDeps: {
        exclude: ['@terra-pulse/db', '@terra-pulse/ingest', '@terra-pulse/schema'],
      },
    },
  },
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
