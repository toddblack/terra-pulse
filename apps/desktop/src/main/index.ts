import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { openDatabase, queryEarthquakes } from '@terra-pulse/db';
import { registerEarthquakeIpcHandlers, refreshEarthquakes } from './ipc/earthquakes';
import { registerExternalLinkIpcHandlers } from './ipc/external-links';

// dotenv.config() with no options resolves relative to process.cwd(), but
// pnpm runs this package's scripts with apps/desktop as cwd, not the repo
// root where .env actually lives — so this is loaded explicitly, from a
// path relative to this file (stable regardless of what launched it).
dotenv.config({ path: join(__dirname, '../../../../.env') });

const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'];
const isDev = Boolean(rendererDevUrl);
// Vite's dev server runs on a dynamic origin (usually localhost:5173, but not
// guaranteed) — derive it from the URL electron-vite actually gave us rather
// than hardcoding a port.
const devServerOrigin = rendererDevUrl ? new URL(rendererDevUrl).origin : '';
const devServerWsOrigin = devServerOrigin.replace(/^http/, 'ws');

// Electron's own "Electron Security Warning" console notices (distinct from
// the CSP itself) are dev-only advisories — they're already suppressed
// automatically once the app is packaged. The unsafe-eval one specifically
// is a trade-off we've already reviewed and documented below, not something
// still being evaluated, so there's no need to see it on every reload.
if (isDev) {
  process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';
}

// 'unsafe-eval' is required by CesiumJS itself (internal WASM instantiation
// for tile decoding, plus some dynamic-function patterns) — this is inherent
// to the library in both dev and production regardless of which basemaps are
// active, not something this app introduces. connect-src/img-src staying
// locked to specific hosts is the more load-bearing protection here.
//
// No Cesium Ion domain here — nothing in this app talks to Ion. That was
// only ever needed for Cesium World Terrain, which has been removed (Ion's
// free tier is non-commercial only, and terrain needs day/night lighting to
// be visible at all, which conflicts with wanting the whole globe lit).
//
// No earthquake.usgs.gov here either, and deliberately so: this CSP governs
// what the *renderer* can reach, and the USGS ingest fetch runs entirely in
// the main process (see ipc/earthquakes.ts), which isn't subject to it at
// all. The renderer only ever sees normalized data over IPC.
//
// 'unsafe-inline' on script-src and the dev server's own origin on
// connect-src are dev-only: Vite's dev client injects an inline bootstrap
// script and needs its HMR websocket, neither of which exist in a built app.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-eval'${isDev ? " 'unsafe-inline'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  // OpenStreetMapImageryProvider requests the bare tile.openstreetmap.org
  // domain, not a subdomain of it — a *.tile.openstreetmap.org wildcard
  // alone does not match that, so both forms are listed explicitly.
  "img-src 'self' data: blob: https://gibs.earthdata.nasa.gov https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
  `connect-src 'self' https://gibs.earthdata.nasa.gov https://tile.openstreetmap.org https://*.tile.openstreetmap.org${isDev ? ` ${devServerOrigin} ${devServerWsOrigin}` : ''}`,
  "worker-src 'self' blob:",
].join('; ');

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // The inspector sits left of the viewport centre (where a selected event
    // is flown to); below roughly this width the two would start to collide.
    minWidth: 940,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Not sandboxed: sandboxed preloads load through a restricted internal
      // shim that can't execute ES module `import` syntax, which is what our
      // preload compiles to (tied to this package's "type": "module"). The
      // non-negotiable here is contextIsolation + nodeIntegration: false with
      // an explicit minimal preload bridge — all still true below.
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Nothing in this app should ever navigate the window away from its own UI,
  // or spawn an Electron window for an external site. Both are denied outright
  // — external links go through the validated shell:open-external handler and
  // open in the user's real browser instead (PROJECT_PLAN §8).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // The dev server reloads by navigating to its own origin; that's the one
    // legitimate case. Everything else is blocked.
    if (rendererDevUrl && url.startsWith(devServerOrigin)) return;
    event.preventDefault();
    console.warn('Blocked in-app navigation to:', url);
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    });
  });

  // A rejected load leaves a blank window with no other symptom — worth
  // logging rather than letting it fail silently.
  const load = rendererDevUrl
    ? mainWindow.loadURL(rendererDevUrl)
    : mainWindow.loadFile(join(__dirname, '../renderer/index.html'));

  load.catch((error: unknown) => {
    console.error('Failed to load the renderer', error);
  });
}

app
  .whenReady()
  .then(async () => {
    const db = openDatabase(join(app.getPath('userData'), 'terra-pulse.sqlite'));
    registerEarthquakeIpcHandlers(db);
    registerExternalLinkIpcHandlers();

    // Populate on first run (empty db) rather than always fetching on start —
    // a manual refresh is available via IPC for anything after that.
    if (queryEarthquakes(db, {}).length === 0) {
      await refreshEarthquakes(db).catch((error: unknown) => {
        console.error('Initial earthquake fetch failed', error);
      });
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error: unknown) => {
    // Opening the database or registering IPC failed — the app cannot work
    // from here, so make it loud rather than showing an empty window.
    console.error('Startup failed', error);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
