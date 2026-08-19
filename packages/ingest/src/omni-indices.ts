import { DST_START_YEAR, type SpaceWeatherSample } from '@terra-pulse/schema';

/**
 * **Dst, solar wind speed and IMF Bz** from NASA's OMNI2 hourly dataset,
 * back to 1963.
 *
 * The wind fields cost nothing to add: they are columns 17 and 25 of the same
 * 55-field row this adapter was already downloading for Dst and discarding.
 *
 * ## OMNI is time-shifted to the bow shock nose, and that governs the live tail
 *
 * OMNI does not publish raw L1 measurements — it propagates them to the bow
 * shock nose. Any adapter filling the recent gap must therefore use SWPC's
 * *propagated* product rather than its raw real-time stream, or the series
 * silently changes meaning partway along. Same rule that keeps SWPC's modelled
 * Dst and NOAA's estimated Kp out of this app; see `swpc-solar-wind.ts`.
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
/**
 * Bz in **GSM**, one column past Bz in GSE — and they are not interchangeable.
 * GSM is referenced to Earth's magnetic dipole, so a southward Bz there means
 * field antiparallel to Earth's, which is the reconnection condition that
 * drives storms. Taking column 15 instead would give a plausible-looking series
 * that answers a different question.
 */
const FIELD_BZ_GSM = 16;
const FIELD_DENSITY = 23;
const FIELD_WIND_SPEED = 24;
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
/**
 * The wind fills, each width-matched to its own field like Dst's.
 *
 * `9999` km/s is eleven times the fastest wind ever recorded and `999.9` nT is
 * roughly a hundred times the strongest IMF, so neither survives a sanity check
 * — but only if one is applied. Read straight through they are ordinary
 * numbers in a numeric column.
 */
const WIND_SPEED_FILL = 9999;
const DENSITY_FILL = 999.9;
const BZ_FILL = 999.9;

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

    const dst = readField(fields[FIELD_DST], DST_FILL);
    const windSpeed = readField(fields[FIELD_WIND_SPEED], WIND_SPEED_FILL);
    const density = readField(fields[FIELD_DENSITY], DENSITY_FILL);
    const bzGsm = readField(fields[FIELD_BZ_GSM], BZ_FILL);

    // Dropped only when the row carries *nothing* this adapter reads. Rows with
    // one field and not another are the normal case rather than an oddity: Dst
    // is near-complete from 1963 while the solar wind is 32-42% present through
    // 1985-1994, so most of that decade is Dst-only.
    if (dst === null && windSpeed === null && bzGsm === null && density === null) continue;

    samples.push({
      timeUtc: hourFromDayOfYear(year, dayOfYear, hour),
      // Never a value: GFZ owns this column. A number here would overwrite it.
      kp: null,
      dst,
      windSpeed,
      density,
      bzGsm,
      // OMNI2's file predates GOES XRS entirely and carries no flux column.
      xrayFlux: null,
    });
  }

  return samples;
}

/** A numeric field, or null when it is absent or carries its fill sentinel. */
function readField(raw: string | undefined, fill: number): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value !== fill ? value : null;
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
