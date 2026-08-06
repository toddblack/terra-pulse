import { app, BrowserWindow, Notification, session } from 'electron';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { openDatabase } from '@terra-pulse/db';
import {
  ALERT_MAX_AGE_MS,
  ALERT_MIN_MAGNITUDE,
  type EarthquakeSyncResult,
} from '@terra-pulse/schema';
import { createArchiveController, registerArchiveIpcHandlers } from './ipc/archive';
import { createLargeEventAlerter } from './ipc/large-event-alerts';
import { collectMissedEvents, registerMissedEventsHandler } from './ipc/missed-events';
import {
  backfillEarthquakes,
  registerEarthquakeIpcHandlers,
  startEarthquakePolling,
} from './ipc/earthquakes';
import { registerExternalLinkIpcHandlers } from './ipc/external-links';
import { applyTileIdentity } from './tile-identity';

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
  // wms.gebco.net serves the GEBCO bathymetry basemap. Listed as an exact
  // host with no wildcard, like every other entry — each one here is a place
  // this app is permitted to talk to, so they get added deliberately and
  // narrowly.
  "img-src 'self' data: blob: https://gibs.earthdata.nasa.gov https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://wms.gebco.net",
  `connect-src 'self' https://gibs.earthdata.nasa.gov https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://wms.gebco.net${isDev ? ` ${devServerOrigin} ${devServerWsOrigin}` : ''}`,
  // Was falling through to default-src. Stated explicitly because the alert
  // sound is the first media this app loads, and a silent CSP fallback is a
  // bad thing to depend on — 'self' covers both the packaged app and the dev
  // server, since each is the renderer's own origin.
  "media-src 'self'",
  "worker-src 'self' blob:",
].join('; ');

function createWindow(): BrowserWindow {
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
      // Chromium blocks audio until the page has seen a user gesture. That
      // rule exists to stop web pages ambushing people; here the whole point
      // of the alert sound is that it reaches you when you are *not* looking
      // at the app, so waiting for a click would defeat it entirely.
      autoplayPolicy: 'no-user-gesture-required',
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

  // Identifies the app to the tile servers. Without this, OSM answers 403 with
  // "not following the tile usage policy" once you zoom in — their policy
  // requires a User-Agent naming the app and rejects a library's generic
  // default, which is exactly what stock Electron sends. See tile-identity.ts.
  applyTileIdentity(session.defaultSession, app.getVersion());

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

  return mainWindow;
}

// No longer async: startup does no awaiting at all now. Everything it needs is
// already on disk, and the backfill runs alongside the window rather than in
// front of it.
app
  .whenReady()
  .then(() => {
    const db = openDatabase(join(app.getPath('userData'), 'terra-pulse.sqlite'));
    registerExternalLinkIpcHandlers();

    // Declared before the window exists so the handler is registered by the
    // time the renderer's first status query lands; the send is guarded because
    // progress can arrive while the window is being torn down.
    let mainWindow: BrowserWindow | null = null;
    const archive = createArchiveController(db, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('archive:progress', progress);
      }
    });
    registerArchiveIpcHandlers(archive);

    // The window comes up first, before any network work.
    //
    // This used to `await backfillEarthquakes(db)` and only then create the
    // window, which made the app's time-to-first-pixel the time of two live
    // FDSN queries plus their inserts. That was a couple of seconds against a
    // 30-day cache and minutes once the archive shared the table — and it fails
    // worse than it sounds: if USGS is slow or unreachable, an app that could
    // have shown the entire local catalogue instead shows nothing at all.
    //
    // The database already holds everything from last run, so there is nothing
    // to wait for. Backfill is a refresh, not a prerequisite.
    mainWindow = createWindow();

    const notifyRenderer = (result: EarthquakeSyncResult) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('earthquakes:updated', result);
      }
    };

    /**
     * Large-event alerts (PROJECT_PLAN §5.8). Notification, not warning — the
     * event has already happened, and early warning is impossible from this
     * input (§11).
     */
    const alerter = createLargeEventAlerter({
      minMagnitude: ALERT_MIN_MAGNITUDE,
      maxAgeMs: ALERT_MAX_AGE_MS,
      onAlert: (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('earthquakes:large-event', event);
        }

        // An in-app banner is useless when the app isn't what you're looking
        // at, and this is the one case worth surfacing at OS level. Never
        // while focused — that would duplicate the banner.
        if (Notification.isSupported() && mainWindow && !mainWindow.isFocused()) {
          new Notification({
            title: `M${event.magnitude.toFixed(1)} earthquake`,
            body: event.place,
          }).show();
        }
      },
    });

    // Deliberately not awaited. Closes the gap from the app having been shut —
    // the poll only covers the last 24h — and tells the renderer when it lands
    // so the globe picks the new events up.
    void backfillEarthquakes(db)
      .then(notifyRenderer)
      .catch((error: unknown) => {
        console.error('Startup earthquake backfill failed', error);
      });

    // Push updates to the renderer rather than having it poll the database.
    // Registered here rather than beside the other handlers because the
    // alerter needs `mainWindow` to exist first.
    registerEarthquakeIpcHandlers(db, alerter);

    // Read *before* polling starts, and served on request rather than pushed.
    // The first poll fires immediately and moves the seen-through watermark, so
    // this cannot be recomputed later — and a push would race the renderer's
    // subscription, which happens in a React effect after paint.
    registerMissedEventsHandler(collectMissedEvents(db));

    const stopPolling = startEarthquakePolling(db, notifyRenderer, alerter);
    app.on('will-quit', stopPolling);

    // A backfill mid-flight would keep issuing requests and writing to a
    // database that's about to close.
    app.on('will-quit', () => {
      archive.cancel();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
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
