import { gunzipSync } from 'node:zlib';
import type { FocalMechanism, NodalPlane } from '@terra-pulse/schema';
import { GCMT_START_YEAR, momentMagnitude } from '@terra-pulse/schema';

/**
 * The Global CMT catalogue in its "ndk" format — H6's orientation source.
 *
 * ## Shape of the record
 *
 * Five fixed-width 80-character lines per event. The whole catalogue is one
 * file, `jan76_dec<YY>.ndk.gz`: **70,044 events for 1976-2025, 8.8 MB
 * compressed**, measured at 1.7 s to fetch. `NEW_MONTHLY/` extends it into the
 * current year. That makes this by far the cheapest historical ingest here —
 * one request against the GOES report's 21 and OMNI's 63.
 *
 * ## Three things that bite
 *
 * - **Fields are fixed-column, not whitespace-separated.** The geographic name
 *   on line 1 contains spaces, and a negative value can run up against the
 *   field before it with no gap.
 * - **Moments are published in dyne-cm.** `momentMagnitude` carries the
 *   matching constant; the N-m form would shift every magnitude by 1.2.
 * - **44 records carry `:60.0` seconds**, meaning the next minute
 *   (`PDE 1998/09/27 00:57:60.0`). `Date.parse` rejects those outright, so a
 *   parser that trusts it silently drops 44 real events — including M6+ ones —
 *   rather than failing. They are rolled over here.
 *
 * ## Both nodal planes are kept
 *
 * Non-negotiable #7: the adapter emits what the source says. H6 reads only the
 * first plane, and the reason it may safely do so — shear stress is identical
 * on both — is recorded on `NODAL_PLANE_ROUNDING_NOTE` in the schema package,
 * along with why the second must not be used in a stress calculation.
 */
const CATALOG_BASE = 'https://www.ldeo.columbia.edu/~gcmt/projects/CMT/catalog';

/**
 * The combined-file name carries the last complete year it contains, so it
 * changes annually: `jan76_dec25.ndk.gz` today, `jan76_dec26.ndk.gz` once 2026
 * closes.
 *
 * Hard-coding one would work until it silently didn't — the old file keeps
 * being served, so the failure is a catalogue that quietly stops gaining years
 * rather than a 404. Candidates are derived from the clock and probed newest
 * first, which self-heals across the turn of the year without a release.
 */
export function gcmtCombinedCandidates(now: Date = new Date()): string[] {
  const latest = now.getUTCFullYear() - 1;
  const names: string[] = [];
  // Three back is ample slack for a year-end publication lag, and bounded so a
  // wrong clock cannot walk the whole catalogue's history.
  for (let year = latest; year >= latest - 2 && year >= GCMT_START_YEAR; year -= 1) {
    names.push(`jan76_dec${String(year % 100).padStart(2, '0')}`);
  }
  return names;
}

export function gcmtCombinedUrl(name: string): string {
  return `${CATALOG_BASE}/${name}.ndk.gz`;
}

const MONTH_ABBREVIATIONS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

/** Monthly file for one month, e.g. `NEW_MONTHLY/2026/jan26.ndk`. */
export function gcmtMonthlyUrl(year: number, month: number): string {
  const abbreviation = MONTH_ABBREVIATIONS[month - 1];
  if (abbreviation === undefined) throw new Error(`Global CMT: no month ${String(month)}`);
  return `${CATALOG_BASE}/NEW_MONTHLY/${String(year)}/${abbreviation}${String(year % 100).padStart(2, '0')}.ndk`;
}

/**
 * Column offsets, half-open `[start, end)` to match `String.slice`, taken from
 * the published `allorder.ndk_explained` and checked against the real file.
 */
const LINE1 = {
  referenceCatalog: [0, 4],
  date: [5, 15],
  time: [16, 26],
  latitude: [27, 33],
  longitude: [34, 41],
  depth: [42, 47],
} as const;

/**
 * Line 3 must be read by column, and splitting it on whitespace is a trap that
 * only springs on about one event in 35,000.
 *
 * The line holds eight numbers — centroid time shift, latitude, longitude and
 * depth, each followed by its standard error. Splitting looks safe because none
 * of them contains a space. The failure is the opposite: **adjacent fields can
 * run together with no space between them.** A centroid time error of 60.0 s
 * against a shift of 1.0 renders as `1.060.0`, which splits into one token
 * instead of two, shifting every later field left — so latitude reads the
 * latitude *error*, and the event lands at (0.01, 0.01) off the coast of Ghana.
 *
 * Caught by asserting that centroids sit near their hypocentres: three records
 * came out 968-14,228 km away. Two were this, and there is nothing in the
 * format description that warns of it.
 */
const LINE3 = {
  latitude: [22, 29],
  longitude: [34, 42],
  depth: [47, 53],
} as const;

const LINE4 = { exponent: [0, 2] } as const;

const LINE5 = {
  scalarMoment: [49, 56],
  /** Six values from here: strike/dip/rake of plane 1, then of plane 2. */
  nodalPlanes: 57,
} as const;

/**
 * `hh:mm:ss.s`, where the seconds field may legitimately read `60.0`.
 *
 * NDK writes a time one second into the next minute as `:60.0` rather than
 * rolling the minute itself. Returning null instead would discard the event.
 */
function parseTimeOfDay(raw: string): { text: string; rollForwardMs: number } | null {
  const match = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(raw.trim());
  if (!match) return null;
  const [, hh, mm, ss] = match;
  const seconds = Number(ss);
  if (Number(hh) > 23 || Number(mm) > 59 || seconds > 60) return null;
  if (seconds >= 60) {
    return { text: `${hh}:${mm}:${(seconds - 60).toFixed(1).padStart(4, '0')}`, rollForwardMs: 60_000 };
  }
  return { text: `${hh}:${mm}:${ss}`, rollForwardMs: 0 };
}

function finiteAt(line: string, span: readonly [number, number]): number | null {
  const value = Number(line.slice(span[0], span[1]).trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses an ndk document into the shared shape.
 *
 * Split from the fetch so it can be tested against a fixture, like every other
 * adapter here. Blocks that cannot be read are skipped rather than throwing:
 * one malformed record in a 70,000-event file should cost that record, not the
 * ingest. The count is returned by `parseNdkWithSkips` for callers that want to
 * assert the skip rate is near zero, which it is — 0 across the whole record.
 */
export function parseNdk(text: unknown): FocalMechanism[] {
  return parseNdkWithSkips(text).mechanisms;
}

export function parseNdkWithSkips(text: unknown): {
  mechanisms: FocalMechanism[];
  skipped: number;
} {
  if (typeof text !== 'string') {
    throw new Error('Global CMT: expected the catalogue as text');
  }

  const lines = text.split(/\r?\n/);
  const mechanisms: FocalMechanism[] = [];
  let skipped = 0;

  for (let index = 0; index + 4 < lines.length; index += 5) {
    const hypocenter = lines[index];
    const name = lines[index + 1];
    const centroid = lines[index + 2];
    const tensor = lines[index + 3];
    const axes = lines[index + 4];
    if (hypocenter === undefined || hypocenter.trim().length === 0) continue;

    const mechanism = parseBlock(hypocenter, name ?? '', centroid ?? '', tensor ?? '', axes ?? '');
    if (mechanism === null) skipped += 1;
    else mechanisms.push(mechanism);
  }

  mechanisms.sort((a, b) => a.timeUtc.localeCompare(b.timeUtc));
  return { mechanisms, skipped };
}

function parseBlock(
  hypocenter: string,
  nameLine: string,
  centroid: string,
  tensor: string,
  axes: string,
): FocalMechanism | null {
  const id = nameLine.slice(0, 16).trim();
  if (id.length === 0) return null;

  const date = hypocenter.slice(LINE1.date[0], LINE1.date[1]).replace(/\//g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const timeOfDay = parseTimeOfDay(hypocenter.slice(LINE1.time[0], LINE1.time[1]));
  if (timeOfDay === null) return null;

  const parsed = Date.parse(`${date}T${timeOfDay.text}Z`);
  if (!Number.isFinite(parsed)) return null;
  const timeUtc = new Date(parsed + timeOfDay.rollForwardMs).toISOString();

  const latitude = finiteAt(hypocenter, LINE1.latitude);
  const longitude = finiteAt(hypocenter, LINE1.longitude);
  const depthKm = finiteAt(hypocenter, LINE1.depth);
  if (latitude === null || longitude === null || depthKm === null) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  const exponent = finiteAt(tensor, LINE4.exponent);
  const moment = finiteAt(axes, LINE5.scalarMoment);
  if (exponent === null || moment === null || moment <= 0) return null;
  const scalarMomentDyneCm = moment * 10 ** exponent;

  const planeValues = axes
    .slice(LINE5.nodalPlanes)
    .trim()
    .split(/\s+/)
    .map(Number);
  if (planeValues.length !== 6 || planeValues.some((value) => !Number.isFinite(value))) return null;
  const nodalPlane1 = toPlane(planeValues.slice(0, 3));
  const nodalPlane2 = toPlane(planeValues.slice(3, 6));
  if (nodalPlane1 === null || nodalPlane2 === null) return null;

  // Read by column — see LINE3 for the one-in-35,000 record that makes
  // splitting on whitespace wrong here.
  const centroidLatitude = finiteAt(centroid, LINE3.latitude);
  const centroidLongitude = finiteAt(centroid, LINE3.longitude);
  const centroidDepthKm = finiteAt(centroid, LINE3.depth);

  return {
    id,
    timeUtc,
    latitude,
    longitude,
    depthKm,
    magnitude: momentMagnitude(scalarMomentDyneCm),
    scalarMomentDyneCm,
    nodalPlane1,
    nodalPlane2,
    // Falling back to the hypocentre rather than dropping the event: the
    // centroid is not what H6 reads, so an unreadable one must not cost an
    // orientation.
    centroidLatitude: centroidLatitude ?? latitude,
    centroidLongitude: centroidLongitude ?? longitude,
    centroidDepthKm: centroidDepthKm ?? depthKm,
    referenceCatalog: hypocenter.slice(LINE1.referenceCatalog[0], LINE1.referenceCatalog[1]).trim(),
  };
}

function toPlane(values: number[]): NodalPlane | null {
  const [strike, dip, rake] = values;
  if (strike === undefined || dip === undefined || rake === undefined) return null;
  // Published ranges. A value outside them means the columns have drifted,
  // which is worth refusing rather than storing as a fault orientation.
  if (strike < 0 || strike > 360) return null;
  if (dip < 0 || dip > 90) return null;
  if (rake < -180 || rake > 180) return null;
  return { strike, dip, rake };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** One unit of work, named so `gcmt_chunks` can record it. */
export interface GcmtCombinedChunk {
  /** Stable key: the combined file's own name, e.g. `jan76_dec25`. */
  chunk: string;
  kind: 'combined';
}

/**
 * A monthly chunk. `year` and `month` are required rather than optional, so a
 * caller never has to assert they are present — the alternative was two
 * non-null assertions at the only call site, which is the sort of thing that
 * stops being true the moment the shape grows a third kind.
 */
export interface GcmtMonthlyChunk {
  /** Stable key, `YYYY-MM`. */
  chunk: string;
  kind: 'monthly';
  year: number;
  month: number;
}

export type GcmtChunk = GcmtCombinedChunk | GcmtMonthlyChunk;

/**
 * Monthly files that should exist by now, oldest first.
 *
 * Only months of the current year: everything before it is inside the combined
 * file. The **current month is excluded** because it is not finished, the same
 * rule the earthquake archive applies to the current year — recording an
 * unfinished chunk complete is how a resume silently stops resuming.
 */
export function gcmtMonthlyChunks(now: Date = new Date()): GcmtMonthlyChunk[] {
  const year = now.getUTCFullYear();
  const chunks: GcmtMonthlyChunk[] = [];
  for (let month = 1; month < now.getUTCMonth() + 1; month += 1) {
    chunks.push({
      chunk: `${String(year)}-${String(month).padStart(2, '0')}`,
      kind: 'monthly',
      year,
      month,
    });
  }
  return chunks;
}

export interface FetchedChunk {
  chunk: GcmtCombinedChunk;
  mechanisms: FocalMechanism[];
}

/**
 * The whole 1976-onward catalogue, from whichever combined file exists.
 *
 * Probes the candidate names newest first and takes the first that answers, so
 * the turn of the year needs no release. A miss is a 404 rather than an error
 * page, and every candidate missing means the naming scheme changed — which is
 * worth failing on rather than silently ingesting nothing.
 */
export async function fetchGcmtCombined(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<FetchedChunk> {
  const attempted: string[] = [];

  for (const name of gcmtCombinedCandidates(now)) {
    attempted.push(name);
    const response = await fetchImpl(gcmtCombinedUrl(name));
    if (response.status === 404) continue;
    if (!response.ok) {
      throw new Error(
        `Global CMT ${name}: HTTP ${String(response.status)} ${response.statusText}`,
      );
    }

    // The file is gzip *content*, not a gzip transfer encoding, so `fetch` does
    // not unwrap it and the body arrives compressed.
    const text = gunzipSync(Buffer.from(await response.arrayBuffer())).toString('latin1');
    return { chunk: { chunk: name, kind: 'combined' }, mechanisms: parseNdk(text) };
  }

  throw new Error(`Global CMT: no combined catalogue found (tried ${attempted.join(', ')})`);
}

/**
 * One monthly file, or `null` if it has not been published yet.
 *
 * **A 404 here is normal, not a failure.** Global CMT determines solutions "with
 * a three-to-four-month delay", so the most recent few months simply do not
 * exist yet. Treating that as an error would make the backfill fail on every
 * run forever; returning null lets the controller leave the chunk unrecorded so
 * a later run picks it up.
 */
export async function fetchGcmtMonth(
  year: number,
  month: number,
  fetchImpl: typeof fetch = fetch,
): Promise<FocalMechanism[] | null> {
  const response = await fetchImpl(gcmtMonthlyUrl(year, month));
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Global CMT ${String(year)}-${String(month).padStart(2, '0')}: ` +
        `HTTP ${String(response.status)} ${response.statusText}`,
    );
  }
  return parseNdk(await response.text());
}
