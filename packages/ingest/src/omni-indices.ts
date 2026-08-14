import { DST_START_YEAR, type SpaceWeatherSample } from '@terra-pulse/schema';

/**
 * **Dst** from NASA's OMNI2 hourly dataset — the Kyoto WDC index, back to 1963.
 *
 * Verified against ground truth before use: the March 1989 Quebec storm shows
 * as **Dst -589 nT at 1989-03-14 01:00 UT** with **Kp 9** the evening before,
 * which are the documented values.
 *
 * ## Dst only — this deliberately discards OMNI's Kp column
 *
 * OMNI carries both indices and this app used to take both. Kp now comes
 * straight from GFZ Potsdam (`gfz-kp.ts`), which publishes it, reaches 1932
 * instead of 1963, and writes exact thirds rather than OMNI's rounded tenths.
 *
 * Dropping the column here is structural, not tidiness. `insertSpaceWeather`
 * coalesces with **`excluded` winning** whenever it is non-null, and the
 * backfill fetches Kp first and then loops Dst years — so an OMNI sample
 * carrying Kp would overwrite GFZ's value for every hour from 1963 on, undoing
 * the switch on the very run that performed it. Ordering the two phases the
 * other way would hide the problem rather than remove it.
 */
const OMNI2_YEAR_URL = (year: number): string =>
  `https://spdf.gsfc.nasa.gov/pub/data/omni/low_res_omni/omni2_${String(year)}.dat`;

/**
 * Fixed column positions in the whitespace-separated OMNI2 hourly record,
 * zero-based.
 *
 * The format is documented as fixed-width and has been stable for decades, but
 * these are found by splitting on whitespace rather than by character offset —
 * the file pads numbers differently as they gain digits, and a character offset
 * that works for `-5` breaks on `-589`.
 */
const FIELD_YEAR = 0;
const FIELD_DAY_OF_YEAR = 1;
const FIELD_HOUR = 2;
const FIELD_DST = 40;

/** The narrowest row we will accept before giving up on a line. */
const MIN_FIELDS = 45;

/**
 * OMNI's fill value for Dst, which is **not** zero and must never be read as
 * data.
 *
 * Width-matched to the five-digit field. Read as a measurement it becomes a
 * +99999 nT excursion, which would survive every plausibility check a chart
 * applies while being three orders of magnitude past the largest storm ever
 * recorded.
 */
const DST_FILL = 99999;

/** Downloads and parses one year. */
export async function fetchOmniYear(
  year: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SpaceWeatherSample[]> {
  if (year < DST_START_YEAR) {
    throw new Error(`OMNI2 starts at ${String(DST_START_YEAR)}, asked for ${String(year)}`);
  }

  const response = await fetchImpl(OMNI2_YEAR_URL(year));
  if (!response.ok) {
    throw new Error(`OMNI2 ${String(year)}: HTTP ${String(response.status)} ${response.statusText}`);
  }

  return parseOmniHourly(await response.text());
}

/**
 * Parses the hourly records out of an OMNI2 year file.
 *
 * Split out from the fetch so it can be tested against a fixture rather than
 * the network.
 *
 * **Rows whose Dst is fill are dropped**, not stored as a null. An hour with
 * nothing measured carries no information, and keeping ~550,000 of them would
 * bloat the table to say "we don't know" — which is already what a missing row
 * means. Kp is not read at all; see the note at the top of this file.
 */
export function parseOmniHourly(text: string): SpaceWeatherSample[] {
  const samples: SpaceWeatherSample[] = [];

  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < MIN_FIELDS) continue;

    const year = Number(fields[FIELD_YEAR]);
    const dayOfYear = Number(fields[FIELD_DAY_OF_YEAR]);
    const hour = Number(fields[FIELD_HOUR]);
    if (!Number.isInteger(year) || !Number.isInteger(dayOfYear) || !Number.isInteger(hour)) {
      continue;
    }

    const dstRaw = Number(fields[FIELD_DST]);
    if (!Number.isFinite(dstRaw) || dstRaw === DST_FILL) continue;

    samples.push({
      timeUtc: hourFromDayOfYear(year, dayOfYear, hour),
      // Never a value: GFZ owns this column. A number here would overwrite it.
      kp: null,
      dst: dstRaw,
    });
  }

  return samples;
}

/**
 * Day-of-year plus hour to an ISO instant.
 *
 * OMNI dates rows by ordinal day, which `Date.UTC` handles directly: day 1 is
 * January 1, so the offset is `dayOfYear - 1`, and it rolls over leap years
 * without a special case.
 */
export function hourFromDayOfYear(year: number, dayOfYear: number, hour: number): string {
  return new Date(Date.UTC(year, 0, dayOfYear, hour)).toISOString();
}
