import type { WaveformChannel } from '@terra-pulse/schema';

/**
 * Archived waveforms from EarthScope's FDSN dataselect service.
 *
 * The live SeedLink ring keeps only a short rolling buffer; this is the
 * permanent archive behind it — every channel the ring carries, kept for good.
 * Measured 2026-10-01: CI.ISA.HHZ for the 2019 Ridgecrest M7.1 came back as the
 * same 512-byte Steim records the ring serves live, sample counts and all, which
 * is what makes replaying it a faithful test of live behaviour.
 *
 * **`service.earthscope.org`, never `service.iris.edu`** — the old host answers
 * with a redirect Node's `fetch` rejects. See the station-service note in
 * `fdsn-stations.ts`.
 */
export const DATASELECT_URL = 'https://service.earthscope.org/fdsnws/dataselect/1/query';

export const DATASELECT_TIMEOUT_MS = 120_000;

function fdsnTime(ms: number): string {
  // FDSN wants no trailing Z and accepts fractional seconds.
  return new Date(ms).toISOString().replace('Z', '');
}

/**
 * The POST body for a bulk request: one line per channel. A blank location is
 * written `--`, which is FDSN's spelling of "no location code" — sending
 * nothing would shift every later field left by one.
 */
export function dataselectPostBody(channels: readonly WaveformChannel[], startMs: number, endMs: number): string {
  const start = fdsnTime(startMs);
  const end = fdsnTime(endMs);
  return channels
    .map((c) => `${c.network} ${c.station} ${c.location === '' ? '--' : c.location} ${c.channel} ${start} ${end}`)
    .join('\n');
}

export interface FetchDataselectOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Raw miniSEED for every listed channel over one interval, as one byte array
 * of concatenated records (split with `splitMiniSeedRecords`).
 *
 * An empty array means the archive holds nothing for that request — the
 * service answers 204 for that, which is a real answer, not a failure. A
 * transport error or any other status throws, so a dropped connection can
 * never be read as "the stations recorded nothing".
 */
export async function fetchDataselect(
  channels: readonly WaveformChannel[],
  startMs: number,
  endMs: number,
  options: FetchDataselectOptions = {},
): Promise<Uint8Array> {
  const { fetchImpl = fetch, timeoutMs = DATASELECT_TIMEOUT_MS } = options;
  if (channels.length === 0) return new Uint8Array(0);
  const response = await fetchImpl(DATASELECT_URL, {
    method: 'POST',
    body: dataselectPostBody(channels, startMs, endMs),
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'accept-encoding': 'identity' },
  });
  if (response.status === 204 || response.status === 404) return new Uint8Array(0);
  if (!response.ok) {
    throw new Error(`dataselect answered ${String(response.status)} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
