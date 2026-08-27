import { app, BrowserWindow, Notification, screen, session } from 'electron';
import { join } from 'node:path';
import dotenv from 'dotenv';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, readAppState, writeAppState } from '@terra-pulse/db';
import {
  parseWindowBounds,
  placeWindow,
  serialiseWindowBounds,
} from './window-bounds';

/**
 * First-run size, and the floor below which the layout starts colliding.
 *
 * The minimum is not cosmetic: the inspector sits left of the viewport centre
 * at 24rem wide, so its left edge lands 448px from centre. Below 1000px that
 * reaches the left column. Widening the inspector without raising this is what
 * makes them collide — the two are a pair, see EarthquakeInspector.module.css.
 */
const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 1000;
const MIN_WIDTH = 1000;
const MIN_HEIGHT = 600;
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
import { registerAuroraIpcHandlers, startAuroraPolling } from './ipc/aurora';
import { registerTecIpcHandlers } from './ipc/tec';
import {
  registerMagnetometerIpcHandlers,
  startMagnetometerPolling,
} from './ipc/magnetometer';
import {
  createSpaceWeatherController,
  registerSpaceWeatherIpcHandlers,
  startKpPolling,
} from './ipc/space-weather';
import {
  createDonkiController,
  registerDonkiIpcHandlers,
  startDonkiPolling,
} from './ipc/nasa-donki';
import { createGoesFlareController, registerGoesFlareIpcHandlers } from './ipc/goes-flares';
import { createGcmtController, registerGcmtIpcHandlers } from './ipc/gcmt-mechanisms';
import { createEphemerisController, registerEphemerisIpcHandlers } from './ipc/ephemeris';
import { registerExternalLinkIpcHandlers } from './ipc/external-links';
import { createEngineController, registerAnalysisIpcHandlers } from './ipc/analysis';
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

/** Where the remembered size and position live, in the existing key-value table. */
const WINDOW_BOUNDS_KEY = 'window_bounds';

/**
 * How long to wait after the last resize or move before writing.
 *
 * `resize` fires continuously while a window is being dragged, and every write
 * here is a synchronous SQLite transaction on the main process. Without this a
 * single drag would be hundreds of them, competing with the render loop for
 * exactly as long as the reader is watching the window move.
 */
const BOUNDS_SAVE_DEBOUNCE_MS = 400;

function createWindow(db: DatabaseSync): BrowserWindow {
  const placement = placeWindow(
    parseWindowBounds(readAppState(db, WINDOW_BOUNDS_KEY)),
    screen.getAllDisplays().map((display) => display.workArea),
    { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT },
  );

  const mainWindow = new BrowserWindow({
    width: placement.width,
    height: placement.height,
    // Absent when the stored position no longer lands on a display, in which
    // case Electron centres the window — see `placeWindow`.
    ...(placement.x === undefined ? {} : { x: placement.x, y: placement.y }),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
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

  if (placement.maximized) mainWindow.maximize();

  // --- remembering size and position -------------------------------------
  let saveTimer: NodeJS.Timeout | null = null;

  const saveBounds = () => {
    if (mainWindow.isDestroyed()) return;
    // Minimised bounds are not a size anyone chose, and on some platforms are
    // not meaningful at all.
    if (mainWindow.isMinimized()) return;

    // `getNormalBounds`, never `getBounds`: while maximised the latter reports
    // the maximised rectangle, so saving it would make un-maximising restore to
    // full screen and quietly lose the size the reader actually picked.
    writeAppState(
      db,
      WINDOW_BOUNDS_KEY,
      serialiseWindowBounds({ ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() }),
    );
  };

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, BOUNDS_SAVE_DEBOUNCE_MS);
  };

  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  // Not debounced: these are single deliberate acts, and the flag is the whole
  // point of saving them.
  mainWindow.on('maximize', saveBounds);
  mainWindow.on('unmaximize', saveBounds);

  mainWindow.on('close', () => {
    // Flush synchronously. A pending debounce would be cancelled by teardown,
    // so a resize in the last fraction of a second before quitting would be the
    // one change that never got saved.
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    saveBounds();
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
    mainWindow = createWindow(db);

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

    // Space weather. Separate from the earthquake poll because it answers a
    // different question on a different cadence, and because a SWPC outage must
    // not stop the catalogue updating.
    registerAuroraIpcHandlers();
    const stopAuroraPolling = startAuroraPolling((grid) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('aurora:updated', grid);
      }
    });
    app.on('will-quit', stopAuroraPolling);

    // Ground magnetometers. Its own poll for the same reason: a USGS outage
    // must not stop the aurora updating, and vice versa.
    // Pulled on demand rather than polled: a TEC map is 2.4 MB.
    registerTecIpcHandlers();

    registerMagnetometerIpcHandlers();
    const stopMagnetometerPolling = startMagnetometerPolling((readings) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('magnetometer:updated', readings);
      }
    });
    app.on('will-quit', stopMagnetometerPolling);

    // Kp and Dst. The rolling Kp tail runs always — it is an 8 KB read from
    // GFZ's nowcast file. The deep backfill is user-triggered, because its Dst
    // half is 63 OMNI year-files at ~184 MB.
    const spaceWeather = createSpaceWeatherController(db, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('space-weather:progress', progress);
      }
    });
    registerSpaceWeatherIpcHandlers(db, spaceWeather);

    const stopKpPolling = startKpPolling(db, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('space-weather:updated');
      }
    });
    app.on('will-quit', stopKpPolling);
    app.on('will-quit', () => {
      spaceWeather.cancel();
    });

    // Solar flares and CME arrivals — the data H1b and H2b are registered
    // against. Same shape as space weather: a light live tail always running,
    // a user-triggered historical backfill behind it.
    const solarEvents = createDonkiController(db, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('solar-events:progress', progress);
      }
    });
    const notifySolarEventsUpdated = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('solar-events:updated');
      }
    };
    registerDonkiIpcHandlers(db, solarEvents, notifySolarEventsUpdated);

    const stopDonkiPolling = startDonkiPolling(db, notifySolarEventsUpdated);
    app.on('will-quit', stopDonkiPolling);
    app.on('will-quit', () => {
      solarEvents.cancel();
    });

    // The deep half of the same flare record: NOAA's GOES XRS yearly reports,
    // 1996-2016, which H1b registers as its source below 2017. No poller —
    // unlike DONKI this record is closed and will never gain a row.
    const goesFlares = createGoesFlareController(db, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('goes-flares:progress', progress);
      }
    });
    registerGoesFlareIpcHandlers(goesFlares, notifySolarEventsUpdated);
    app.on('will-quit', () => {
      goesFlares.cancel();
    });

    // Global CMT focal mechanisms — H6's fault orientations. User-triggered
    // like every other historical record here, and with no `onUpdated`
    // counterpart: nothing on the globe draws mechanisms, so a completed
    // download changes no view. It is read by the analysis path only.
    const gcmt = createGcmtController(db, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('gcmt:progress', progress);
      }
    });
    registerGcmtIpcHandlers(gcmt);
    app.on('will-quit', () => {
      gcmt.cancel();
    });

    // The JPL DE440 kernel H6 resolves tidal stress with. Downloaded on demand
    // like the records above, but to a file rather than the database — Skyfield
    // reads it in the engine process, so it needs a real path.
    //
    // Kept beside the database in userData rather than in the install
    // directory: a packaged app's resources are read-only on a normal install,
    // and this is user data by every meaning of the word — fetched by them,
    // deletable by them, and not part of the shipped product.
    const ephemeris = createEphemerisController(
      join(app.getPath('userData'), 'ephemeris'),
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ephemeris:progress', progress);
        }
      },
    );
    registerEphemerisIpcHandlers(ephemeris);
    app.on('will-quit', () => {
      ephemeris.cancel();
    });

    // A backfill mid-flight would keep issuing requests and writing to a
    // database that's about to close.
    app.on('will-quit', () => {
      archive.cancel();
    });

    // The Phase 4 statistical engine. Adopts an already-running engine if it
    // finds one healthy on 127.0.0.1:8787 (the normal dev loop — `pnpm
    // engine:dev` in a second terminal), otherwise spawns one: the shipped
    // PyInstaller bundle when packaged, a local Python running the source
    // when not. `engineDir` climbs from the compiled main bundle's own
    // location the same four levels `.env`'s path does above, since both
    // need to reach the repo root regardless of what launched this process.
    const engine = createEngineController({
      engineDir: join(__dirname, '../../../../engine'),
      // Only when packaged. In dev this stays undefined so the engine venv —
      // the source you are actually editing — always wins over a bundle that
      // may have been built hours ago. `TERRA_PULSE_ENGINE_BIN` is the way to
      // aim a dev run at a bundle on purpose.
      bundledEngineDir: app.isPackaged ? join(process.resourcesPath, 'engine') : undefined,
      onStatusChange: (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('analysis:engine-status', status);
        }
      },
    });
    // The ephemeris resolver is passed rather than imported so `analysis.ts`
    // stays testable without a filesystem, and so "where the kernel is" has
    // exactly one definition — the controller's. Only H6 ever calls it.
    registerAnalysisIpcHandlers(db, engine, undefined, () => ephemeris.resolvedPath());
    app.on('will-quit', () => {
      engine.dispose();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(db);
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
