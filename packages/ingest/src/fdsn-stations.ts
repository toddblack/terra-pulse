import {
  WAVEFORM_PICKER_CHANNELS,
  channelIdOf,
  isValidWaveformChannel,
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
  return lines.map((line) => {
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
): Promise<FdsnTextRow[] | null> {
  const query = new URLSearchParams({
    net: '*',
    cha: WAVEFORM_PICKER_CHANNELS.join(','),
    level,
    endafter: today,
    format: 'text',
    nodata: '404',
  });
  try {
    const response = await fetchImpl(`${STATION_SERVICE_URL}?${query.toString()}`, {
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
  } = options;
  const today = utcDate(now);

  const [channelRows, stationRows] = await Promise.all([
    fetchRows(fetchImpl, 'channel', today, timeoutMs),
    fetchRows(fetchImpl, 'station', today, timeoutMs),
  ]);
  // Site names are a nicety; coordinates are the point. A failed station-level
  // request costs the names and nothing else.
  if (channelRows === null || channelRows.length === 0) return null;
  return { channelRows, stationRows: stationRows ?? [] };
}
