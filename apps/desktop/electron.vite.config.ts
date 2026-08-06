import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

/**
 * Cesium's runtime assets — the parts it fetches by URL rather than imports.
 *
 * Workers, the KTX2/Draco decoders, the imagery and font atlases, and the
 * widget stylesheets. They cannot be bundled because Cesium builds their paths
 * at runtime from `CESIUM_BASE_URL`.
 */
const CESIUM_RUNTIME_DIRS = ['Assets', 'ThirdParty', 'Workers', 'Widgets'] as const;

/**
 * Where Cesium looks for the directories above, relative to the host document.
 *
 * Relative on purpose, so one value is correct in both modes: against the dev
 * server it resolves to `http://localhost:…/cesium/`, and in a packaged app it
 * resolves beside `index.html` under `file://`. An absolute `/cesium/` would
 * break the packaged case, where the filesystem root is not the app root.
 */
const CESIUM_BASE_URL = './cesium/';

/**
 * Copies Cesium's runtime assets into the renderer's `public/` directory.
 *
 * ## Why this replaces `vite-plugin-cesium`
 *
 * That plugin computed its output directory as
 * `path.join(config.root, config.build.outDir)`. electron-vite passes an
 * **absolute** `outDir`, and `path.join` does not absorb an absolute second
 * argument — only `path.resolve` does. The result was
 * `src\renderer\C:\…\out\renderer`, which Windows rejects outright:
 *
 *     copy failed Error: Path contains invalid characters
 *
 * **The Windows error was the lucky case.** On macOS and Linux the same join
 * yields `src/renderer/abs/out/renderer` — a valid path that is simply wrong. The
 * build then *succeeds*, having copied 7.9 MB of workers and assets somewhere
 * nothing reads, and produces an app that launches and fails to render the globe.
 * A silent wrong answer on two platforms is worse than a loud one on the third,
 * which is why this is replaced rather than patched around.
 *
 * ## Why `public/` rather than a copy into `outDir`
 *
 * `public/` is Vite's own mechanism for "serve these bytes untouched": the dev
 * server serves it at the root and the build copies it into the output. Using it
 * means dev and build share one code path and one URL, and nothing here has to
 * know where the output directory is — which is precisely the thing the old
 * plugin got wrong.
 *
 * It also keeps the files away from Vite's transform pipeline. Cesium's Workers
 * are plain scripts fetched by URL; served through a route that tried to treat
 * them as ES modules, they break in ways that only show up at runtime.
 */
function cesiumAssets(publicDir: string): Plugin {
  return {
    name: 'terra-pulse:cesium-assets',
    // `buildStart` runs for both `dev` and `build`, so the assets are in place
    // however the app is being started.
    buildStart() {
      const cesiumRoot = dirname(require.resolve('cesium/package.json'));
      const buildDir = join(cesiumRoot, 'Build', 'Cesium');
      const version = (
        JSON.parse(readFileSync(join(cesiumRoot, 'package.json'), 'utf8')) as { version: string }
      ).version;

      const target = join(publicDir, 'cesium');
      const stamp = join(target, '.version');

      // ~7.9 MB of copying on every dev restart is a slow start for no reason.
      // The stamp records which Cesium produced the contents, so an upgrade
      // re-copies and an ordinary restart does not.
      if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version) return;

      mkdirSync(target, { recursive: true });
      for (const dir of CESIUM_RUNTIME_DIRS) {
        cpSync(join(buildDir, dir), join(target, dir), { recursive: true });
      }
      writeFileSync(stamp, version);
      console.log(`cesium: staged runtime assets (${version}) into public/cesium`);
    },
  };
}

const rendererRoot = resolve(import.meta.dirname, 'src/renderer');

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
        // `dotenv` joins the workspace packages in being bundled rather than
        // externalized, and that is a packaging decision as much as a build one:
        // with it inlined, `out/` has **no runtime node_modules dependency at
        // all**. Everything else main touches is either bundled here or a Node
        // built-in that Electron supplies (`node:sqlite`, `node:path`).
        //
        // That lets electron-builder ship `out/` and nothing else. Otherwise it
        // walks `dependencies` and tries to copy cesium, react and the
        // `workspace:^` links into the installer — hundreds of megabytes of
        // packages whose code is already compiled into the bundle.
        exclude: ['@terra-pulse/db', '@terra-pulse/ingest', '@terra-pulse/schema', 'dotenv'],
      },
      // Main and preload stay ESM, matching this package's "type": "module".
      // Verified against the built output: `import { app, BrowserWindow } from
      // 'electron'` works because Electron's own ESM loader resolves `electron`
      // to its internal module. (Plain Node cannot — the npm `electron` package
      // is a CJS shim exporting a path string — so anything running the built
      // main under Node, including a shell with ELECTRON_RUN_AS_NODE=1 set,
      // will fail here in a way that says nothing about the app.)
    },
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    /**
     * Cesium is **bundled**, not loaded from a global.
     *
     * `vite-plugin-cesium` marked it external for builds and injected a
     * `<script>` tag, while leaving dev to import it as a module — so the dev
     * and production builds ran different loading paths, and only the dev one
     * was ever exercised. Bundling makes them the same at the cost of a larger
     * renderer chunk, which for an app loading from local disk buys nothing to
     * keep small.
     */
    define: {
      CESIUM_BASE_URL: JSON.stringify(CESIUM_BASE_URL),
    },
    plugins: [react(), cesiumAssets(join(rendererRoot, 'public'))],
  },
});
