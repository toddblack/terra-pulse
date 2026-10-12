import {
  WAVEFORM_PICKER_CHANNELS,
  channelIdOf,
  isValidWaveformChannel,
  type SeedLinkServerId,
  type WaveformStation,
} from '@terra-pulse/schema';

/**
 * Station coordinates and names for the live-waveform picker, from the FDSN
 * station service, joined to the SeedLink ring's own stream list.
 *
 * ## Why at runtime rather than vendored
 *
 * The region presets are vendored (`scripts/vendor-waveform-stations.mjs`)
 * because there are 32 of them. The picker needs every station the ring
 * carries — ~3,200 — and a vendored list of that size rots: the ring gains and
 * loses stations over weeks, and a stale entry is a row that never draws. The
 * whole thing is two requests, ~1.6 MB and ~3 s measured 2026-09-30, and the
 * feature is useless offline anyway, since the stream itself needs the network.
 * So a runtime fetch costs no robustness and cannot go stale. Verified live the
 * same day: 3,222 stations, every one present on the ring, 3,170 with a name.
 *
 * ## Two requests, because one level does not carry both halves
 *
 * `level=channel` has the location code and sample rate but no site name;
 * `level=station` has the site name but no channels. Fetched in parallel, so
 * the cost is the slower of the two rather than the sum.
 *
 * ## Traps
 *
 * - **`service.earthscope.org`, never `service.iris.edu`** — the old host
 *   answers with a malformed 307 that Node's `fetch` rejects outright. See the
 *   vendor script.
 * - **A future `EndTime` is a current station.** ~650 current channel epochs
 *   carry a planned end date (2027, 2032, even 2099). Treating any non-empty end
 *   time as retired — which the preset vendor script did until 2026-09-30 —
 *   silently drops them. The query asks for `endafter=<today>`, so every row
 *   returned is current.
 * - **Columns are read by name from the header row**, never by position.
 */

export const STATION_SERVICE_URL = 'https://service.earthscope.org/fdsnws/station/1/query';

/** Measured 0.9-2.7 s per request; the bound is for a stall, not a slow day. */
export const STATION_CATALOGUE_TIMEOUT_MS = 20_000;

/** One row of FDSN text output, keyed by the header's own column names. */
export type FdsnTextRow = Record<string, string>;

/**
 * Parses FDSN `format=text`: a `#`-prefixed, pipe-delimited header, then rows.
 *
 * Returns null when there is no header, because a body with no header is not a
 * station listing in a format we understand — and reading it positionally
 * could put a longitude where a latitude belongs with nothing failing.
 */
export function parseFdsnText(text: string): FdsnTextRow[] | null {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const header = lines.shift();
  if (header?.startsWith('#') !== true) return null;
  const columns = header
    .slice(1)
    .split('|')
    .map((name) => name.trim());
  // Later `#` lines are comments, never rows: IRIS's federated catalogue puts a
  // `#DATACENTER=...` line before each data centre's block.
  return lines.filter((line) => !line.startsWith('#')).map((line) => {
    const values = line.split('|');
    return Object.fromEntries(columns.map((name, i) => [name, (values[i] ?? '').trim()]));
  });
}

/** Lower is better. Unknown channel codes never reach here; see the query. */
function channelRank(channel: string): number {
  const rank = (WAVEFORM_PICKER_CHANNELS as readonly string[]).indexOf(channel);
  return rank === -1 ? Number.POSITIVE_INFINITY : rank;
}

/**
 * Blank first, then `00`, then the rest in order.
 *
 * Blank and `00` are each a network's primary sensor by convention; IU stations
 * carry several (`00`, `10`, `60`), and the alternates are typically a second
 * or borehole instrument.
 */
function locationRank(location: string): string {
  if (location === '') return '0';
  if (location === '00') return '1';
  return `2${location}`;
}

function isBetter(candidate: WaveformStation, current: WaveformStation): boolean {
  const byChannel = channelRank(candidate.channel) - channelRank(current.channel);
  if (byChannel !== 0) return byChannel < 0;
  return locationRank(candidate.location) < locationRank(current.location);
}

/**
 * One channel per station, for stations the ring actually publishes.
 *
 * **Keyed on network + station**, so a station carrying both `HHZ` and `BHZ`
 * contributes one row, not two — each row is meant to be a different place.
 *
 * Rows failing the SeedLink code whitelist are dropped here rather than left
 * for main to refuse: one malformed code in a picked set would otherwise fail
 * the whole `start` request, taking seven good stations with it.
 */
export function buildStationCatalogue(
  channelRows: readonly FdsnTextRow[],
  stationRows: readonly FdsnTextRow[],
  onRing: ReadonlySet<string>,
  /** Tagged on every station unless it is EarthScope, which an absent tag means. */
  server: SeedLinkServerId = 'earthscope',
): WaveformStation[] {
  const siteNames = new Map<string, string>();
  for (const row of stationRows) {
    const site = row.SiteName ?? '';
    if (site !== '') siteNames.set(`${row.Network ?? ''}_${row.Station ?? ''}`, site);
  }

  const best = new Map<string, WaveformStation>();
  for (const row of channelRows) {
    const network = row.Network ?? '';
    const stationCode = row.Station ?? '';
    // Some FDSN services write a blank location as `--`; the ring writes it as
    // nothing at all, and the ids must match.
    const rawLocation = row.Location ?? '';
    const location = rawLocation === '--' ? '' : rawLocation;
    const channel = row.Channel ?? '';
    const candidate: WaveformStation = {
      network,
      station: stationCode,
      location,
      channel,
      latitude: Number(row.Latitude),
      longitude: Number(row.Longitude),
      site: siteNames.get(`${network}_${stationCode}`) ?? stationCode,
      sampleRateHz: Number(row.SampleRate),
      ...(server === 'earthscope' ? {} : { server }),
    };

    if (!isValidWaveformChannel(candidate)) continue;
    if (channelRank(channel) === Number.POSITIVE_INFINITY) continue;
    if (!onRing.has(channelIdOf(candidate))) continue;
    if (
      !Number.isFinite(candidate.latitude) ||
      !Number.isFinite(candidate.longitude) ||
      Math.abs(candidate.latitude) > 90 ||
      Math.abs(candidate.longitude) > 180
    ) {
      continue;
    }
    if (!Number.isFinite(candidate.sampleRateHz) || candidate.sampleRateHz <= 0) continue;

    const key = `${network}_${stationCode}`;
    const current = best.get(key);
    if (current === undefined || isBetter(candidate, current)) best.set(key, candidate);
  }

  return [...best.values()].sort(
    (a, b) => a.network.localeCompare(b.network) || a.station.localeCompare(b.station),
  );
}

export interface FetchStationListingOptions {
  fetchImpl?: typeof fetch;
  now?: Date;
  timeoutMs?: number;
  /** Which FDSN station service — EarthScope's when absent. */
  serviceUrl?: string;
  /** FDSN `net` pattern; every network when absent. */
  networks?: string;
}

/** The `endafter` value: today in UTC, which keeps every current epoch. */
function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function fetchRows(
  fetchImpl: typeof fetch,
  level: 'channel' | 'station',
  today: string,
  timeoutMs: number,
  serviceUrl: string,
  networks: string,
): Promise<FdsnTextRow[] | null> {
  const query = new URLSearchParams({
    net: networks,
    cha: WAVEFORM_PICKER_CHANNELS.join(','),
    level,
    endafter: today,
    format: 'text',
    nodata: '404',
  });
  try {
    const response = await fetchImpl(`${serviceUrl}?${query.toString()}`, {
      signal: AbortSignal.timeout(timeoutMs),
      // The service does not compress today (measured), but this is the host
      // family whose compressed reply crashed the main process in a way no
      // `catch` can reach — see RING_INVENTORY_IDENTITY_NOTE. Asking explicitly
      // means a server-side change cannot reintroduce it here.
      headers: { 'accept-encoding': 'identity' },
    });
    if (!response.ok) return null;
    return parseFdsnText(await response.text());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Instrument gains, for the magnitude estimate
// ---------------------------------------------------------------------------

/**
 * Sensors whose response falls off below a few hertz — geophones. The Pd
 * magnitude needs displacement down to ~0.1 Hz, which these cannot deliver
 * (measured: PB's HS-1-LT stations read 1.25-1.59 magnitude units low). Listed
 * by name because the band code does not catch them: PB labels its 200 Hz
 * geophone channels `HHZ`, a code SEED reserves for broadband sensors.
 */
const SHORT_PERIOD_SENSOR = /\bHS-?1\b|\bL-?22|\bL-?4[A-Z]?\b|\bGS-?1[13]|geophone/i;

/**
 * Counts per m/s for a channel-level row, or null when the channel cannot
 * give ground displacement the Pd relation can use.
 *
 * Refused: a gain that is missing or not positive; units other than velocity
 * (an accelerometer's `m/s**2` would need integrating twice and is not in
 * the picker's channel list anyway); short-period band codes (`E`, `S`); and
 * the geophones named above. The service writes units as both `m/s` and `M/S`.
 */
export function velocityGainOf(row: FdsnTextRow): number | null {
  const scale = Number(row.Scale);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  if ((row.ScaleUnits ?? '').toLowerCase() !== 'm/s') return null;
  const band = (row.Channel ?? '').charAt(0);
  if (band === 'E' || band === 'S') return null;
  if (SHORT_PERIOD_SENSOR.test(row.SensorDescription ?? '')) return null;
  return scale;
}

/** FDSN text times have no zone and up to four fractional digits; they are UTC. */
function fdsnTimeMs(value: string): number {
  if (value === '') return Number.POSITIVE_INFINITY;
  return Date.parse(`${value.replace(/(\.\d{3})\d+$/, '$1')}Z`);
}

/**
 * The velocity gain in force for a channel at an instant, from channel-level
 * rows spanning several epochs. Null if no epoch covers it or that epoch's
 * sensor cannot be used (`velocityGainOf`).
 *
 * **Per epoch, because gains change.** Sensors are swapped and digitisers
 * replaced; measured on the 74 stations around Burbank, 2019-2026 spans 158
 * epochs, up to 7 for one station. A replay of 2020 using today's gain would
 * be wrong by whatever that swap changed, with nothing to show for it.
 */
export function velocityGainAt(rows: readonly FdsnTextRow[], channelId: string, atMs: number): number | null {
  for (const row of rows) {
    const id = channelIdOf({
      network: row.Network ?? '',
      station: row.Station ?? '',
      location: row.Location === '--' ? '' : (row.Location ?? ''),
      channel: row.Channel ?? '',
    });
    if (id !== channelId) continue;
    if (atMs >= fdsnTimeMs(row.StartTime ?? '') && atMs < fdsnTimeMs(row.EndTime ?? '')) {
      return velocityGainOf(row);
    }
  }
  return null;
}

/**
 * Every channel-level epoch overlapping [startMs, endMs] for the given
 * channels, by POST so a long list does not run into a URL limit. Null on any
 * failure, like the listing.
 */
export async function fetchChannelEpochs(
  channels: readonly Pick<WaveformStation, 'network' | 'station' | 'location' | 'channel'>[],
  startMs: number,
  endMs: number,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; serviceUrl?: string } = {},
): Promise<FdsnTextRow[] | null> {
  const { fetchImpl = fetch, timeoutMs = STATION_CATALOGUE_TIMEOUT_MS, serviceUrl = STATION_SERVICE_URL } = options;
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
  const lines = channels.map(
    (c) => `${c.network} ${c.station} ${c.location === '' ? '--' : c.location} ${c.channel} ${iso(startMs)} ${iso(endMs)}`,
  );
  try {
    const response = await fetchImpl(serviceUrl, {
      method: 'POST',
      body: ['level=channel', 'format=text', 'nodata=404', ...lines].join('\n'),
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'accept-encoding': 'identity' },
    });
    if (!response.ok) return null;
    return parseFdsnText(await response.text());
  } catch {
    return null;
  }
}

/** Both halves of the station service's answer, before the ring join. */
export interface StationListing {
  channelRows: FdsnTextRow[];
  /** Site names only; empty when that request failed. */
  stationRows: FdsnTextRow[];
}

/**
 * The station service's listing of current vertical channels, or null when it
 * cannot be had.
 *
 * **Independent of the ring inventory on purpose**, so the caller can run the
 * two side by side. Measured 2026-09-30: the ring's list takes ~3.1 s and this
 * ~2.8 s; done in sequence the picker waited ~6 s after the mode opened, done
 * together ~3 s. The join is `buildStationCatalogue`.
 *
 * Null rather than empty rows on failure, for the same reason
 * `fetchRingInventory` fails open: an empty list would read as "nothing is
 * published anywhere". A body that parses to no rows is a failure too — the
 * format changed, the world did not empty.
 */
export async function fetchStationListing(
  options: FetchStationListingOptions = {},
): Promise<StationListing | null> {
  const {
    fetchImpl = fetch,
    now = new Date(),
    timeoutMs = STATION_CATALOGUE_TIMEOUT_MS,
    serviceUrl = STATION_SERVICE_URL,
    networks = '*',
  } = options;
  const today = utcDate(now);

  const [channelRows, stationRows] = await Promise.all([
    fetchRows(fetchImpl, 'channel', today, timeoutMs, serviceUrl, networks),
    fetchRows(fetchImpl, 'station', today, timeoutMs, serviceUrl, networks),
  ]);
  // Site names are a nicety; coordinates are the point. A failed station-level
  // request costs the names and nothing else.
  if (channelRows === null || channelRows.length === 0) return null;
  return { channelRows, stationRows: stationRows ?? [] };
}
