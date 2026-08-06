import type { Session } from 'electron';

/**
 * Identifies this app to the tile servers it fetches basemap imagery from.
 *
 * ## The bug this fixes
 *
 * Zooming in on the OpenStreetMap basemap produced blocks of **HTTP 403** with
 * OSM's "App is not following the tile usage policy" body. Nothing was wrong
 * with the request rate — the requests were simply anonymous.
 *
 * OSM's tile usage policy requires "a clear, unique User-Agent string that names
 * your app", and explicitly rejects "a library's generic default User-Agent".
 * Electron sends stock Chromium, which is exactly that. The packaged app also
 * loads from `file://`, so there is no `Referer` either — and the policy warns
 * that "traffic using generic defaults, referer-stripping, or spoofed identities
 * may be blocked without notice". Both halves of that describe us.
 *
 * The policy does permit apps distributed to end users, provided they identify
 * themselves. So this is the whole fix: say who we are.
 *
 * ## Why it lives in main
 *
 * The renderer cannot set `User-Agent` — Chromium treats it as a forbidden
 * header for `fetch`/XHR, and Cesium builds these requests internally anyway.
 * The session's `webRequest` hook is the only place the header can be attached,
 * and network policy belongs in main regardless (PROJECT_PLAN §8).
 *
 * ## Why it is scoped to tile hosts
 *
 * Setting a global User-Agent would change the identity of every request the
 * renderer makes, including any future service that behaves differently for
 * non-browser clients. Only the hosts that require identification get it.
 */

/**
 * The hosts this app fetches map imagery from.
 *
 * OSM is the one that enforces identification, but GIBS and GEBCO are public
 * services run on someone else's budget too, and an anonymous desktop client is
 * no more welcome there. Identifying to all three costs nothing.
 */
export const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'gibs.earthdata.nasa.gov',
  'wms.gebco.net',
] as const;

/**
 * Builds the User-Agent string.
 *
 * Shaped to OSM's requirement: names the app, carries a version, and includes a
 * contact URL so an operator with a complaint has somewhere to send it. The
 * contact is the point — an identifier nobody can reach is only marginally
 * better than none.
 *
 * Deliberately **not** appended to the Chromium UA. The policy calls masquerading
 * as another app grounds for blocking, and a string containing "Chrome/…" invites
 * exactly that reading.
 */
export function tileUserAgent(version: string): string {
  return `TerraPulse/${version} (+https://github.com/toddblack/terra-pulse)`;
}

/** Matches a URL against `TILE_HOSTS`. Exported for its test. */
export function isTileRequest(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // An unparseable URL is not a tile request. Returning false leaves it
    // untouched rather than stamping our identity onto something unknown.
    return false;
  }
  return TILE_HOSTS.some((tileHost) => host === tileHost || host.endsWith(`.${tileHost}`));
}

/**
 * Attaches the identifying User-Agent to outbound tile requests.
 *
 * Call once, before the window loads anything.
 */
export function applyTileIdentity(targetSession: Session, version: string): void {
  const userAgent = tileUserAgent(version);

  targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!isTileRequest(details.url)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }

    callback({
      requestHeaders: { ...details.requestHeaders, 'User-Agent': userAgent },
    });
  });
}
