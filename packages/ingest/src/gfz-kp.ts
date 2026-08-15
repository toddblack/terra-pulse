import type { SpaceWeatherSample } from '@terra-pulse/schema';

/**
 * Kp from GFZ Potsdam — the index's actual publisher, back to 1932.
 *
 * This is the **sole** source of Kp in the app. It replaced two others:
 *
 *   - **OMNI2** carried Kp from 1963 and still carries Dst. OMNI sources its Kp
 *     from GFZ, so going direct costs nothing and gains thirty-one years.
 *   - **SWPC's planetary K** filled the last seven days. That series is NOAA's
 *     *estimate* from eight stations, not the IAGA index from thirteen
 *     observatories — the same "same name, different quantity" trap that keeps
 *     SWPC's modelled Dst out of this app. GFZ's own nowcast file covers the
 *     tail with the real index, so the estimate is no longer needed.
 *
 * The result is one homogeneous Kp series, 1932 to today, from one publisher,
 * with a definitive/preliminary flag on every day.
 *
 * ## GFZ was reachable all along
 *
 * An earlier note in this repo claimed GFZ was blocked at the TCP level for its
 * whole address range. That was wrong. `fetch` retrieves both files in well
 * under a second; what fails is **curl on this machine specifically**, which
 * returns error 43 against GFZ while returning 200 against USGS. It is built on
 * the Schannel TLS backend, and GFZ trips it. Nothing about the network, the
 * host or the app's runtime was ever involved — so if a source ever looks
 * unreachable, check it with the runtime that will actually fetch it before
 * concluding anything.
 *
 * Source: https://kp.gfz.de/en/data — CC BY 4.0.
 * Matzka, J., Stolle, C., Yamazaki, Y., Bronkalla, O. and Morschhauser, A.,
 * 2021. The geomagnetic Kp index and derived indices of geomagnetic activity.
 * Space Weather, https://doi.org/10.1029/2020SW002641
 */

/** The whole record, 1932 to a day or two ago. One request, ~5.5 MB. */
const GFZ_ARCHIVE_URL = 'https://kp.gfz.de/app/files/Kp_ap_Ap_SN_F107_since_1932.txt';

/**
 * The last thirty days, ~8 KB, in the identical format.
 *
 * Worth having as a separate endpoint rather than re-reading the archive: the
 * tail is polled every fifteen minutes, and 5.5 MB at that cadence to collect a
 * handful of new rows would be 500 MB a day for nothing.
 *
 * It is also *fresher* than the archive file, which lags it by about a day —
 * observed with 2026-08-13's final interval published as Kp 2.667 in the
 * archive and revised to 3.000 in the nowcast.
 */
const GFZ_NOWCAST_URL = 'https://kp.gfz.de/app/files/Kp_ap_Ap_SN_F107_nowcast.txt';

/**
 * Column positions in the 28-field daily row, zero-based.
 *
 * The layout is `YYYY MM DD days days_m Bsr dB Kp1..Kp8 ap1..ap8 Ap SN
 * F10.7obs F10.7adj D`. Found by splitting on whitespace rather than by
 * character offset — the file is nominally fixed-width, but a parser anchored
 * to columns breaks the first time a field gains a digit.
 */
const FIELD_YEAR = 0;
const FIELD_MONTH = 1;
const FIELD_DAY = 2;
const FIELD_FIRST_KP = 7;

/** Kp is a three-hour index, so a day carries eight values. */
const KP_INTERVALS_PER_DAY = 8;
const HOURS_PER_KP_INTERVAL = 3;

/** Every data row has exactly this many fields. Anything else is not a row. */
const FIELD_COUNT = 28;

/**
 * GFZ's fill value for an undetermined Kp.
 *
 * Kp is bounded 0-9, so a negative is unambiguous — unlike OMNI's `99`, which
 * sits inside the plausible range of the field it fills. It appears on the
 * current day in the nowcast file, where later intervals have not happened yet.
 */
const KP_FILL = -1;

/** Downloads and parses the full record, 1932 to a day or two ago. */
export async function fetchGfzKpArchive(
  fetchImpl: typeof fetch = fetch,
): Promise<SpaceWeatherSample[]> {
  return parseGfzKp(await fetchText(GFZ_ARCHIVE_URL, fetchImpl, 'archive'));
}

/** Downloads and parses the last thirty days, including today so far. */
export async function fetchGfzKpNowcast(
  fetchImpl: typeof fetch = fetch,
): Promise<SpaceWeatherSample[]> {
  return parseGfzKp(await fetchText(GFZ_NOWCAST_URL, fetchImpl, 'nowcast'));
}

async function fetchText(url: string, fetchImpl: typeof fetch, label: string): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`GFZ Kp ${label}: HTTP ${String(response.status)} ${response.statusText}`);
  }
  return response.text();
}

/**
 * Parses the daily rows out of either GFZ file — they share a format.
 *
 * Split out from the fetch so it can be tested against a fixture rather than
 * the network, the same way the OMNI and aurora adapters are.
 *
 * ## Kp is published in thirds, and this keeps them
 *
 * GFZ writes `2.667` — a third rounded to three decimals, not the exact
 * rational. OMNI writes the same value as an integer tenth, `27`, which divides
 * to `2.7`. The app used to store OMNI's form with a comment saying that was
 * how the index is published. It isn't — this is the publisher.
 *
 * Measured across the whole record: one value in three is an integer and lands
 * exactly; the other two thirds are the `.333` and `.667` roundings.
 *
 * The two disagree by at most 0.033, which is invisible on a chart and, more
 * importantly, **cannot move a threshold**: Kp's integer values are exact in
 * both conventions, and every threshold in this app and in `HYPOTHESES.md` sits
 * on an integer (display emphasis at 5, H4c's registered trigger at 6). So a
 * database still holding some OMNI-era Kp rows is imprecise, never wrong.
 *
 * ## Three-hour values are expanded to hourly
 *
 * The `space_weather` table is keyed by the hour, because Dst is hourly. Each
 * Kp interval therefore writes its three hours rather than only its first,
 * which is what OMNI does internally too — the alternative leaves two of every
 * three hours empty and makes the record look full of gaps it doesn't have.
 */
export function parseGfzKp(text: string): SpaceWeatherSample[] {
  const samples: SpaceWeatherSample[] = [];

  for (const line of text.split('\n')) {
    // The column-label line is a comment, so this skips it along with the
    // rest of the ~40-line preamble.
    if (line.startsWith('#')) continue;

    const fields = line.trim().split(/\s+/);
    if (fields.length !== FIELD_COUNT) continue;

    const year = Number(fields[FIELD_YEAR]);
    const month = Number(fields[FIELD_MONTH]);
    const day = Number(fields[FIELD_DAY]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) continue;

    for (let interval = 0; interval < KP_INTERVALS_PER_DAY; interval += 1) {
      const kp = Number(fields[FIELD_FIRST_KP + interval]);
      // Undetermined, and there is nothing else on the row to store — a sample
      // with both indices null says exactly what a missing row already says.
      if (!Number.isFinite(kp) || kp === KP_FILL) continue;

      const startHour = interval * HOURS_PER_KP_INTERVAL;
      for (let offset = 0; offset < HOURS_PER_KP_INTERVAL; offset += 1) {
        samples.push({
          timeUtc: new Date(Date.UTC(year, month - 1, day, startHour + offset)).toISOString(),
          kp,
          // Never a value. GFZ publishes Kp, ap, sunspot number and F10.7 —
          // Dst comes from Kyoto via OMNI and must not be invented here.
          dst: null,
        });
      }
    }
  }

  return samples;
}
