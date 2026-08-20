import type { SolarFlare } from '@terra-pulse/schema';
import { GOES_FLARE_LAST_YEAR, GOES_FLARE_START_YEAR } from '@terra-pulse/schema';
import { parseFlareClass } from './nasa-donki';

/**
 * NOAA's GOES XRS yearly flare reports — the deep half of H1b's registered
 * source ("NOAA GOES XRS flare reports for 1996-2016; NASA DONKI /FLR for 2017
 * onward").
 *
 * ## This is not `swpc-goes-xray.ts`
 *
 * That adapter reads *raw X-ray flux* — a live, one-minute rolling window,
 * reduced to hourly peaks, feeding `space_weather.xray_flux`. This one reads
 * *classified flare events*: a catalogue of discrete flares, each already given
 * a class by NOAA, going back thirty years. Same instrument and the same
 * 0.1-0.8 nm long channel that flare classification is defined on; completely
 * different product, and only this one can supply a trigger set.
 *
 * ## Why 1996 and not 1975
 *
 * The reports reach back to 1975, but GOES 1-7 fluxes need a documented scaling
 * correction, so "M1.0" before 1996 is not the same threshold as after. See
 * `GOES_FLARE_START_YEAR` in the schema package for the full reasoning — the
 * short version is that applying an unsourced correction is the free parameter
 * non-negotiable #3 forbids.
 *
 * ## Fixed-width, verified against numbers already in this repo
 *
 * Every field is read at a fixed offset; the class letter sits at index 59 in
 * every row of every year checked. That column map was validated by counting
 * M/X flares per year and comparing against the independently-measured table in
 * `packages/schema/src/solar-events.ts` — it reproduces all six DONKI-overlap
 * years exactly (2011:119, 2012:130, 2013:111, 2014:221, 2015:106, 2016:16).
 * Measured totals for 1996-2016: **36,601 classified flares, 2,308 of them
 * M1.0+**. Largest is X28 on 2003-11-04, which is the largest ever recorded.
 */
const BASE_URL =
  'https://www.ngdc.noaa.gov/stp/space-weather/solar-data/solar-features/solar-flares/x-rays/goes/xrs';

/**
 * 2015 is served from a corrected file, and this is the one year that is.
 *
 * The standard `goes-xrs-report_2015.txt` carries 106 M/X flares against
 * DONKI's 126 for the same year — a 20% disagreement recorded in
 * `FLARE_COMPLETE_SINCE_YEAR`'s note as "real and unexplained", with a guess
 * that GOES's report was partial across a satellite transition. NOAA's own
 * corrected file confirms that guess: 119 M/X, closing most of the gap. Taking
 * the standard file instead would knowingly discard 13 real M/X flares in a
 * solar-max year.
 */
const YEAR_FILENAMES: Readonly<Record<number, string>> = {
  2015: 'goes-xrs-report_2015_modifiedreplacedmissingrows.txt',
};

export function goesFlareReportUrl(year: number): string {
  const filename = YEAR_FILENAMES[year] ?? `goes-xrs-report_${String(year)}.txt`;
  return `${BASE_URL}/${filename}`;
}

/** Every year this app ingests, oldest first. Closed at both ends and entirely in the past. */
export function goesFlareYears(): number[] {
  const years: number[] = [];
  for (let year = GOES_FLARE_START_YEAR; year <= GOES_FLARE_LAST_YEAR; year += 1) years.push(year);
  return years;
}

/** Fetches and parses one year's report. */
export async function fetchGoesFlareYear(
  year: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SolarFlare[]> {
  const url = goesFlareReportUrl(year);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(
      `NOAA GOES XRS ${String(year)}: HTTP ${String(response.status)} ${response.statusText}`,
    );
  }
  return parseGoesFlareReport(await response.text(), year);
}

/**
 * Column offsets, as measured against the real files rather than read off a
 * format description. Half-open `[start, end)`, matching `String.slice`.
 */
const COLUMN = {
  yymmdd: [5, 11],
  startHhmm: [13, 17],
  endHhmm: [18, 22],
  peakHhmm: [23, 27],
  position: [28, 44],
  classLetter: 59,
  magnitude: [60, 64],
  activeRegion: [80, 86],
} as const;

/**
 * Two-digit years, pivoted at the start of the GOES record.
 *
 * `96` is 1996 and `15` is 2015. The reports began in 1975, so anything from 75
 * up is twentieth century and anything below is twenty-first — a pivot that
 * stays correct until 2075, by which point the two-digit field is somebody
 * else's problem.
 */
function fullYear(twoDigit: number): number {
  return twoDigit >= 75 ? 1900 + twoDigit : 2000 + twoDigit;
}

function hhmmToMinutes(raw: string): number | null {
  if (!/^\d{4}$/.test(raw)) return null;
  const hours = Number(raw.slice(0, 2));
  const minutes = Number(raw.slice(2, 4));
  // 24:00 appears as an end time in this record and is a legal way to write
  // midnight; anything past it is not.
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function instant(year: number, month: number, day: number, minutesOfDay: number): string {
  return new Date(Date.UTC(year, month - 1, day, 0, minutesOfDay, 0, 0)).toISOString();
}

/**
 * Of two records for the same flare, the one that says more.
 *
 * Only reached for the 11 near-duplicate groups described above. Counting
 * populated optional fields rather than picking by line order means the stored
 * record is the better of the two whichever way round the file lists them —
 * arbitrary is easy to write and impossible to reason about later.
 */
function richerOf(a: SolarFlare, b: SolarFlare): SolarFlare {
  const score = (flare: SolarFlare): number =>
    (flare.sourceLocation === null ? 0 : 1) +
    (flare.activeRegionNumber === null ? 0 : 1) +
    (flare.endTimeUtc === null ? 0 : 1);
  return score(b) > score(a) ? b : a;
}

/**
 * Parses one yearly report into the shared `SolarFlare` shape.
 *
 * Split out from the fetch so it can be tested against a fixture, like every
 * other adapter here.
 *
 * ## Rows this drops, and why dropping is right
 *
 * - **No X-ray class.** A handful of rows per year are optical subflare reports
 *   carrying a position but no class at all (12 across 1996-2016). Nothing can
 *   be said about whether they clear M1.0, so they are dropped rather than
 *   guessed at — the same rule `parseFlares` applies to DONKI.
 * - **Peak before start on an event that does not cross midnight.** Four rows
 *   across the whole record read like `1800 2153 0011`, where the peak cannot
 *   be placed on either day without contradicting the other two times. All four
 *   are B or C class; **none is M1.0+**, so this never touches a trigger set.
 *
 * ## Midnight crossing is real and is handled
 *
 * 242 rows genuinely cross midnight — `2359 0008 0004`, meaning the flare began
 * at 23:59 and peaked four minutes later on the *following* day. 24 of them are
 * M/X. Reading the peak on the start date would put those triggers 24 hours
 * early, so the rule is: when the event's end precedes its start, the event
 * spans midnight, and any of end/peak that also precede the start belong to the
 * next day.
 *
 * ## Duplicates, unlike DONKI
 *
 * `parseFlares` documents that DONKI does not duplicate and needs no dedupe
 * pass. **That does not transfer.** Measured across 1996-2016: **305 groups of
 * rows share a (date, peak, class) identity, and 294 of those groups are
 * byte-identical repeated lines** — the file simply lists them twice. The
 * synthesised id collapses them, which is what makes re-running the backfill an
 * upsert rather than a duplicate insert.
 *
 * The remaining 11 groups differ slightly, and every one is the *same* flare
 * re-reported with different completeness — one line carrying an optical
 * position and active region, the other not, or a flux differing in its last
 * digit. `richerOf` keeps whichever record says more, so the choice isn't
 * left to line order. **All 11 are C class or below**, so none of this reaches
 * an M1.0+ trigger set; it only affects what the globe and the detail panel
 * show.
 */
export function parseGoesFlareReport(text: unknown, expectedYear?: number): SolarFlare[] {
  if (typeof text !== 'string') {
    throw new Error('NOAA GOES XRS: expected the report as text');
  }

  const flares = new Map<string, SolarFlare>();

  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;

    const classLetter = line[COLUMN.classLetter];
    if (classLetter === undefined) continue;

    const magnitudeRaw = line.slice(...COLUMN.magnitude).trim();
    // Guarded explicitly rather than left to `Number`, which turns an empty
    // field into 0 and would manufacture a "C0.0" flare out of a row that
    // carries no magnitude at all.
    if (!/^\d{1,3}$/.test(magnitudeRaw)) continue;
    // The published class is split across two fixed columns — the letter, then
    // the significand times ten. `C 21` is C2.1 and `X280` is X28.0, which is
    // why this cannot be read as a single number.
    const parsed = parseFlareClass(`${classLetter}${(Number(magnitudeRaw) / 10).toString()}`);
    if (!parsed) continue;

    const yymmdd = line.slice(...COLUMN.yymmdd);
    if (!/^\d{6}$/.test(yymmdd)) continue;
    const year = fullYear(Number(yymmdd.slice(0, 2)));
    const month = Number(yymmdd.slice(2, 4));
    const day = Number(yymmdd.slice(4, 6));
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    // A row whose date disagrees with the file it came from means the offsets
    // have drifted, which is worth refusing rather than storing.
    if (expectedYear !== undefined && year !== expectedYear) continue;

    const startMinutes = hhmmToMinutes(line.slice(...COLUMN.startHhmm));
    const peakMinutes = hhmmToMinutes(line.slice(...COLUMN.peakHhmm));
    const endMinutes = hhmmToMinutes(line.slice(...COLUMN.endHhmm));
    // Peak time is the instant a flare is dated by, so a row without one cannot
    // be placed on a timeline at all.
    if (startMinutes === null || peakMinutes === null) continue;

    const MINUTES_PER_DAY = 24 * 60;
    const crossesMidnight = endMinutes !== null && endMinutes < startMinutes;
    if (!crossesMidnight && peakMinutes < startMinutes) continue;

    const peakOffset = peakMinutes < startMinutes ? MINUTES_PER_DAY : 0;
    const endOffset = endMinutes !== null && endMinutes < startMinutes ? MINUTES_PER_DAY : 0;

    const peakTimeUtc = instant(year, month, day, peakMinutes + peakOffset);
    const beginTimeUtc = instant(year, month, day, startMinutes);
    const endTimeUtc = endMinutes === null ? null : instant(year, month, day, endMinutes + endOffset);

    const position = line.slice(...COLUMN.position).trim();
    const activeRegionRaw = line.slice(...COLUMN.activeRegion).trim();
    const activeRegion = /^\d+$/.test(activeRegionRaw) ? Number(activeRegionRaw) : null;

    // GOES publishes no identifier of its own, so one is synthesised from the
    // fields that identify the flare physically. Namespaced `goes:` so it can
    // never collide with a DONKI id in the years both catalogues cover.
    const id = `goes:${peakTimeUtc}-${parsed.flareClass}${String(parsed.magnitude)}`;

    const flare: SolarFlare = {
      id,
      source: 'goes',
      classType: `${parsed.flareClass}${String(parsed.magnitude)}`,
      flareClass: parsed.flareClass,
      magnitude: parsed.magnitude,
      peakTimeUtc,
      beginTimeUtc,
      endTimeUtc,
      // Kept exactly as published, for the reason given on
      // `SolarFlare.sourceLocation`: a position past the limb is a real value
      // that a naive parse would silently accept as a point on the visible disc.
      sourceLocation: position.length > 0 ? position : null,
      activeRegionNumber: activeRegion,
      // The yearly reports carry no per-flare link.
      link: null,
    };

    const existing = flares.get(id);
    flares.set(id, existing === undefined ? flare : richerOf(existing, flare));
  }

  return [...flares.values()].sort((a, b) => a.peakTimeUtc.localeCompare(b.peakTimeUtc));
}
