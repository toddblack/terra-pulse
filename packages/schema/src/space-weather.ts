/**
 * Geomagnetic activity indices — Kp and Dst.
 *
 * The half of space weather that *has* a history. The auroral oval is a nowcast
 * with no archive; these go back decades, so they follow the scrubber and can
 * be put on the same time axis as the earthquake catalogue. They are also the
 * data H4c is registered against (`HYPOTHESES.md`), so what is stored here has to
 * be good enough for a rate claim, not just for a picture.
 */

/**
 * Where each index starts. They are **not** the same year, and a single
 * constant covering "space weather" would have to be wrong about one of them.
 *
 * Same shape as the earthquake archive's `ARCHIVE_START_YEAR` /
 * `DEEP_ARCHIVE_START_YEAR` split, and for the same reason: two tiers of record
 * with genuinely different depths, and code that assumes the shallower one
 * would silently under-report the deeper.
 *
 * Kp reaches 1932 because it comes straight from GFZ Potsdam, which publishes
 * the index. Dst reaches 1963 because it comes from Kyoto WDC via NASA's OMNI2,
 * verified column-for-column against the March 1989 Quebec storm (Dst -589 nT
 * at 1989-03-14 01:00 UT, Kp 9 the evening before — both sources agree).
 *
 * The table stores the two independently, so a row may legitimately carry Kp
 * and no Dst for thirty-one years' worth of hours.
 */
export const KP_START_YEAR = 1932;
export const DST_START_YEAR = 1963;

/**
 * Solar wind needs **two** years, and conflating them would wreck any rate.
 *
 * OMNI carries solar wind speed and IMF from 1963, so that is where the data
 * starts. It is not where the data becomes *usable*, because coverage depends
 * on whether a spacecraft was sitting at L1 — and for a decade, none was.
 *
 * Measured across the real OMNI record, fraction of hours carrying a speed:
 *
 * | era | coverage | why |
 * |---|---|---|
 * | 1963-1970 | 8 -> 61% | early scattered spacecraft |
 * | 1980 | 92% | ISEE-3 parked at L1 |
 * | **1985-1994** | **32-42%** | ISEE-3 left L1 in 1982; IMP-8 only, and it spends much of its orbit inside the magnetosphere |
 * | 1995 onward | 98-100% | WIND, then ACE from 1998, then DSCOVR |
 *
 * **Coverage is not monotonic**, which is what makes this dangerous: it climbs
 * to 92%, collapses for a decade, then recovers. Any "it gets better over time"
 * assumption is simply false here.
 *
 * The number that decides the epoch is not coverage but whether H3b's detection
 * metric can run at all. H3b defines a stream onset as sustained speed above a
 * threshold for **six hours**, so what matters is the fraction of six-hour
 * windows with no gap in them:
 *
 * | year | speed coverage | longest gap | 6h windows intact |
 * |---|---|---|---|
 * | 1993 | 33% | 146 h | **16.9%** |
 * | 1994 | 42% | 150 h | 24.8% |
 * | **1995** | 98.5% | 40 h | **97.6%** |
 *
 * A 5.8x swing in detectability from spacecraft coverage alone. Counting stream
 * onsets across the whole record would find far more of them after 1995 for
 * purely instrumental reasons — the same trap as running a decade-scale
 * correlation on M4.5+ earthquakes, and it would favour *any* driver that
 * trends across the period.
 */
export const SOLAR_WIND_START_YEAR = 1963;
export const SOLAR_WIND_COMPLETE_SINCE_YEAR = 1995;

/* Not JSDoc: this documents a property of the data, not a symbol.
 *
 * **A gap survives 1995, and it points the wrong way.**
 *
 * `SOLAR_WIND_COMPLETE_SINCE_YEAR` fixes the *era* problem, not this one. Even
 * inside the well-covered years, missing wind is **not random with respect to
 * intensity** — the instrument drops out hardest during the largest events.
 * Measured on the real 2003 record, around the Halloween storm:
 *
 * | date | hours with no speed | max speed | min Dst |
 * |---|---|---|---|
 * | 2003-10-28 | 10 of 24 | 809 | -32 |
 * | **2003-10-29** | **24 of 24** | — | **-350** |
 * | **2003-10-30** | **24 of 24** | — | **-383** |
 * | 2003-10-31 | 1 of 24 | 1189 | -307 |
 *
 * **59 of 2003's 72 missing hours — 82% — fall on those four days.** That is
 * ACE's plasma instrument saturating: solar energetic particles blind SWEPAM
 * exactly when the wind is most extreme. Dst rides straight through at -383,
 * because ground magnetometers do not saturate.
 *
 * So the series is missing *preferentially at its own maxima*. Anything
 * counting high-speed events under-counts the biggest ones, and treating a gap
 * as "no stream" would drop the strongest cases from the sample entirely.
 * Dst and Kp stay present through these hours, so they are what distinguishes a
 * genuinely quiet spell from a blinded instrument.
 *
 * There is no constant for this because there is nothing to switch on — it is a
 * property of the data that any analysis over it has to handle.
 */

/**
 * Kp runs 0 to 9 in thirds — 28 distinct values, verified against the full GFZ
 * record: 0, 0.333, 0.667, 1, 1.333 ... i.e. 0, 0+, 1-, 1, 1+.
 *
 * Stored as GFZ publishes it. An earlier version stored OMNI2's form, which
 * rounds each third to a tenth (`0.3` for "0+") and carried a comment claiming
 * that was the published convention. It isn't; OMNI truncates, and this app now
 * reads the publisher directly.
 *
 * The two forms differ by at most 0.033 and **agree exactly on the integers**,
 * which is where every threshold in this app sits — so rows left over from the
 * OMNI era are imprecise, never misclassified.
 */
export const KP_MAX = 9;

/**
 * Kp at or above which conditions count as a geomagnetic storm (NOAA G1).
 *
 * Used for emphasis on the track, not for any test — H4c's registered trigger is
 * **Kp >= 6**, which is a different and deliberately higher bar. Keeping the
 * two apart matters: a display threshold that drifted into the analysis would
 * be exactly the free-parameter-after-the-fact non-negotiable #3 forbids.
 */
export const KP_STORM_THRESHOLD = 5;

/** Dst at or below which conditions count as an intense storm, in nT. */
export const DST_STORM_THRESHOLD = -100;

/**
 * One hour of space weather.
 *
 * Every field is nullable and **independently so**. They come from different
 * instruments with different reporting lags and genuinely different coverage —
 * Kp reaches 1932, Dst 1963, and the solar wind is patchy until 1995 — so a
 * given hour routinely carries some and not others. A missing value must stay
 * missing: filling it with zero would read as "quiet" for an index or "no wind"
 * for a speed, neither of which anyone measured, and both of which would bias
 * any rate computed over them.
 */
export interface SpaceWeatherSample {
  /** Hour start, ISO 8601 UTC. */
  timeUtc: string;
  /** Planetary K index, 0-9, or null when not reported. */
  kp: number | null;
  /** Disturbance storm time index in nT, negative during storms, or null. */
  dst: number | null;
  /**
   * Solar wind bulk speed in km/s, or null.
   *
   * H3b's registered quantity. Typically 300-500 km/s at solar minimum; a
   * coronal-hole high-speed stream runs 500-800. Observed range across the real
   * OMNI record for 1989: 280-918.
   */
  windSpeed: number | null;
  /**
   * Solar wind proton density in cm^-3, or null.
   *
   * Carried for **dynamic pressure**, which is what compresses the dayside
   * magnetosphere: P ~ density x speed^2. Neither number alone says how hard
   * the wind is pushing — a fast tenuous stream and a slow dense one can exert
   * the same force — so the magnetopause standoff calculation (§5.6) needs both.
   *
   * Density rather than OMNI's precomputed flow-pressure column, because SWPC's
   * live product publishes density and not pressure. Taking pressure from one
   * source and deriving it in the other would put two subtly different
   * quantities in one series: OMNI's includes an alpha-particle correction that
   * a proton-only derivation does not.
   */
  density: number | null;
  /**
   * North-south component of the interplanetary magnetic field in nT, in
   * **GSM** coordinates, or null.
   *
   * GSM rather than GSE deliberately, and they are not interchangeable: GSM is
   * referenced to Earth's magnetic dipole, so it is the frame in which a
   * *southward* Bz means field antiparallel to Earth's — the condition that
   * lets the solar wind reconnect with the magnetosphere and drive a storm. In
   * GSE the same physical field gives a different number, and OMNI publishes
   * both, one column apart.
   *
   * Not registered data for any hypothesis — H3b is speed alone. This is carried
   * for Explore, and because the magnetopause standoff calculation the plan
   * wants for §5.6 needs it.
   */
  bzGsm: number | null;
  /**
   * GOES X-ray flux in the 0.1-0.8 nm (1-8 Å) long channel, W/m², or null.
   *
   * The channel flare classification is defined on — each letter (A/B/C/M/X)
   * is one decade of this exact quantity — so it is what NOAA's own charts
   * and every space-weather source call "the" X-ray flux, not the shorter
   * 0.05-0.4 nm channel GOES also publishes. See
   * `packages/ingest/src/swpc-goes-xray.ts`.
   *
   * Live only: SWPC's JSON product covers the last few days, and there is no
   * archive behind it yet — a real gap, not an oversight. See that module's
   * doc for what a historical GOES XRS ingest would actually require.
   */
  xrayFlux: number | null;
}

/** Whether an hour qualifies as stormy by either index. */
export function isStormy(sample: SpaceWeatherSample): boolean {
  if (sample.kp !== null && sample.kp >= KP_STORM_THRESHOLD) return true;
  if (sample.dst !== null && sample.dst <= DST_STORM_THRESHOLD) return true;
  return false;
}

/**
 * One drawn interval — a span of hours reduced to the two numbers worth showing.
 *
 * Two, not one, because either alone misleads at width. The peak alone paints a
 * decade as permanently stormy: every bucket reports its worst hour, so a track
 * of quiet years with one storm each looks identical to a track of continuous
 * disturbance. The typical alone loses the storms entirely, which is the thing
 * the track exists to show.
 */
export interface SpaceWeatherBucket {
  /** First hour in the bucket — what the mark is positioned by. */
  timeUtc: string;
  /** Highest Kp in the span. Null when no hour in it reported one. */
  peakKp: number | null;
  /** Median Kp — the level the span mostly sat at. */
  typicalKp: number | null;
  /** Most negative Dst in the span, which is the disturbed direction. */
  peakDst: number | null;
  /** Fastest solar wind in the span. */
  peakWindSpeed: number | null;
  /** Median solar wind speed. */
  typicalWindSpeed: number | null;
  /**
   * Most **southward** Bz in the span — the minimum, not the maximum.
   *
   * Southward is the geoeffective direction: it is antiparallel to Earth's
   * field, which is what allows reconnection. Taking the maximum would report
   * the least interesting hour of every bucket.
   */
  peakBzGsm: number | null;
  /** Hours in the span, measured or not — the width of the interval. */
  hours: number;
  /**
   * Hours that actually carried a value, per quantity.
   *
   * Separate from `hours` because **absent and quiet are different claims**, and
   * on a bar chart they draw identically: a bucket with no measurement and a
   * bucket that measured nothing notable both produce a short bar or none.
   *
   * This matters most exactly where the data is most interesting. Around the
   * 2003 Halloween storm the wind is missing for 48 straight hours while Dst
   * reads -383, and drawn without this the row says "the wind stopped" rather
   * than "nobody could measure it".
   */
  kpHours: number;
  windSpeedHours: number;
  /** Highest X-ray flux in the span, W/m². */
  peakXrayFlux: number | null;
  /** Median X-ray flux — see `lowerMedian`; never a mean, for the same reason as Kp and wind. */
  typicalXrayFlux: number | null;
  xrayFluxHours: number;
}

/**
 * Top of the solar wind speed scale, in km/s.
 *
 * Fixed rather than fitted to each view, for the reason the geomagnetic field
 * layer's domain is fixed: rescaling per window renormalises the marks on every
 * scrub and hides exactly what the track exists to show.
 *
 * 1000 measured against 34,259 real hours pooled from 1974, 2003, 2015 and
 * 2024: p50 450, p90 656, p99 782, p99.9 877, max 1189. It **clips 0.035%** of
 * hours — about one in 2,900 — which is the price of putting the ordinary
 * 250-800 range across three quarters of the height instead of a third of it.
 * A ceiling of 1200 clips nothing and spends a fifth of the track on values
 * that essentially never occur.
 */
export const WIND_SPEED_MAX = 1000;

/**
 * Where the wind counts as fast, in km/s — **for display emphasis only**.
 *
 * 500 is the conventional slow/fast boundary, and H3b registers its stream onset
 * at the same number for the same reason. They are kept as separate values
 * regardless, exactly as `KP_STORM_THRESHOLD` is kept apart from H4c's trigger:
 * if the registered threshold is ever amended, this one must not silently
 * follow, because a display constant tracking an analysis constant is how a
 * free parameter gets chosen after the fact.
 */
export const FAST_WIND_THRESHOLD = 500;

/**
 * X-ray flux domain, W/m² — plotted on a **log** scale, not fitted to each
 * view, for the same reason `WIND_SPEED_MAX` is fixed: rescaling per window
 * would renormalise the ramp on every scrub.
 *
 * Not measured against this app's own archive the way `WIND_SPEED_MAX` was —
 * there is no historical GOES ingest yet to measure against (see
 * `SpaceWeatherSample.xrayFlux`'s doc). The domain instead comes from NOAA's
 * own published flare-classification scale, which is externally verified
 * rather than a guess: A/B/C/M/X are exactly the decades from 1e-8 to 1e-4
 * W/m², so `[1e-9, 1e-3]` covers "below A" through X10 — six orders of
 * magnitude, clipping only the rare flares past X10 (the largest ever
 * recorded, 2003's "X28", would still land at the very top rather than
 * being clipped away entirely).
 */
export const XRAY_FLUX_MIN = 1e-9;
export const XRAY_FLUX_MAX = 1e-3;

/**
 * M-class, W/m² — where a flare starts being the geoeffective kind DONKI's
 * own layer already draws (`flareAtLeast(flare, 'M')`, H1b's registered
 * trigger). Display emphasis only, the same relationship `KP_STORM_THRESHOLD`
 * has to H4c's trigger — kept as its own constant so the two cannot drift
 * apart silently if either is ever amended.
 */
export const XRAY_EMPHASIS_FLUX = 1e-5;

/**
 * Reduces a series to at most `buckets` intervals for drawing.
 *
 * A decade is ~87,600 hourly samples against a track a few hundred pixels wide,
 * so something has to give.
 *
 * ## Never the mean — and the median is not a loophole
 *
 * Averaging a decade into 300 buckets would flatten every storm in the record
 * into the background, producing a chart whose whole subject is missing. That
 * is why the peak is carried.
 *
 * There is a second and independent reason the mean is out: **Kp is
 * quasi-logarithmic**, so the arithmetic mean of two Kp values is not a
 * meaningful quantity at all. The linear equivalent is `ap`, which is what any
 * future analysis wanting an average level must use.
 *
 * The median is fine, and precisely because it is an **order statistic** — it
 * selects an observed value rather than computing a new one, so it never does
 * arithmetic the index doesn't support. For an even count it takes the lower of
 * the two middle values rather than splitting them, which keeps the answer on
 * Kp's own 28-value scale instead of inventing a reading between two rungs.
 */
export function downsampleSpaceWeather(
  samples: readonly SpaceWeatherSample[],
  buckets: number,
): SpaceWeatherBucket[] {
  if (buckets <= 0 || samples.length === 0) return [];

  const out: SpaceWeatherBucket[] = [];
  const size = samples.length / Math.min(buckets, samples.length);

  for (let b = 0; b < Math.min(buckets, samples.length); b += 1) {
    const start = Math.floor(b * size);
    const end = Math.min(Math.floor((b + 1) * size), samples.length);
    if (end <= start) continue;

    let peakKp: number | null = null;
    let peakDst: number | null = null;
    let peakWindSpeed: number | null = null;
    let peakBzGsm: number | null = null;
    let peakXrayFlux: number | null = null;
    const kpValues: number[] = [];
    const speedValues: number[] = [];
    const fluxValues: number[] = [];

    for (let i = start; i < end; i += 1) {
      const sample = samples[i];
      if (!sample) continue;
      if (sample.kp !== null) {
        kpValues.push(sample.kp);
        if (peakKp === null || sample.kp > peakKp) peakKp = sample.kp;
      }
      if (sample.dst !== null && (peakDst === null || sample.dst < peakDst)) {
        peakDst = sample.dst;
      }
      if (sample.windSpeed !== null) {
        speedValues.push(sample.windSpeed);
        if (peakWindSpeed === null || sample.windSpeed > peakWindSpeed) {
          peakWindSpeed = sample.windSpeed;
        }
      }
      // Minimum, not maximum: southward is the geoeffective direction.
      if (sample.bzGsm !== null && (peakBzGsm === null || sample.bzGsm < peakBzGsm)) {
        peakBzGsm = sample.bzGsm;
      }
      if (sample.xrayFlux !== null) {
        fluxValues.push(sample.xrayFlux);
        if (peakXrayFlux === null || sample.xrayFlux > peakXrayFlux) peakXrayFlux = sample.xrayFlux;
      }
    }

    out.push({
      // The bucket is labelled with its first hour, so a mark's position on the
      // axis is a time that actually exists rather than an interpolated midpoint.
      timeUtc: samples[start]?.timeUtc ?? '',
      peakKp,
      typicalKp: lowerMedian(kpValues),
      peakDst,
      peakWindSpeed,
      // A median again, though speed is linear and a mean would be defensible.
      // Consistency is worth more here: both rows' bars then mean the same
      // thing, and an order statistic cannot invent a reading between two
      // samples on either.
      typicalWindSpeed: lowerMedian(speedValues),
      peakBzGsm,
      hours: end - start,
      // Length of the value lists: every measured hour pushed exactly once.
      kpHours: kpValues.length,
      windSpeedHours: speedValues.length,
      peakXrayFlux,
      // Flux is a genuine linear quantity, so nothing forces a median here the
      // way Kp's quasi-logarithmic scale does — but a mean would still flatten
      // a bucket containing one sharp flare spike into background noise, the
      // exact failure this file already rejected a mean for on Kp and speed.
      typicalXrayFlux: lowerMedian(fluxValues),
      xrayFluxHours: fluxValues.length,
    });
  }

  return out;
}

/**
 * The lower of the two middle values, or the middle one for an odd count.
 *
 * Deliberately not the mean of the middle pair: see the note above on Kp being
 * quasi-logarithmic. This always returns a value that was actually observed.
 */
function lowerMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/**
 * What the Kp/Dst backfill is doing, as the renderer sees it.
 *
 * Shaped like `ArchiveProgress` on purpose — same lifecycle, same panel idiom,
 * and one less thing to learn.
 */
export interface SpaceWeatherProgress {
  state: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled';
  /**
   * Which half is running.
   *
   * The two indices no longer cost anything like the same: Kp is a single ~5.5
   * MB request covering the whole record, Dst is one file per year from 1963.
   * A bar driven by years alone would sit at zero through the Kp phase and then
   * jump, so the phase is named rather than averaged away.
   */
  phase: 'kp' | 'dst' | null;
  /** Whether the deep Kp record is stored. One request, so it is all or nothing. */
  kpComplete: boolean;
  /** Dst years already stored, including from earlier runs. */
  completedYears: number;
  totalYears: number;
  storedSamples: number;
  currentYear: number | null;
  error: string | null;
}

/**
 * A ground magnetometer observatory.
 *
 * Unlike the auroral oval — which is organised by the magnetic poles and
 * therefore sits over almost nowhere that has large earthquakes — ground
 * magnetometers respond to storms at **all** latitudes, through currents
 * induced in the ground rather than through particle precipitation. Measured
 * against this app's own catalogue: 21.3% of M7+ events have an INTERMAGNET
 * station within 500 km, against 0.77% under the ordinary auroral oval.
 *
 * That reach is why H4b was registered against this network — and H4b was
 * **withdrawn unrun on 2026-08-20**, so this type now serves the live Explore
 * layer alone and nothing here feeds an analysis.
 */
export interface MagnetometerStation {
  /** IAGA three-letter code. */
  code: string;
  name: string;
  latitude: number;
  /** Degrees east, -180 to 180. */
  longitude: number;
  agency: string | null;
}

/**
 * How disturbed one station is over a window.
 *
 * The **range of the horizontal component in nT** — largest minus smallest.
 * Deliberately not converted to a K index: the K scale is quasi-logarithmic and
 * each observatory has its own conversion table, so a K is neither comparable
 * between stations nor averageable, which is the same trap Kp already poses. A
 * range in nT is a measurement any reader can compare directly.
 */
export interface StationDisturbance {
  code: string;
  rangeNt: number;
  /** How many readings the range was taken from, so a thin hour is visible. */
  samples: number;
  observedAtUtc: string;
}

/**
 * Where a station's disturbance stops being ordinary, in nT per hour.
 *
 * **Display emphasis only, and now the only station-level threshold here.**
 * H4b registered a per-station trigger — the 99th percentile of *that
 * station's own* distribution — which this flat value could never stand in
 * for: a quiet mid-latitude site and an auroral-zone site differ by an order
 * of magnitude on an ordinary day. **H4b was withdrawn unrun on 2026-08-20**,
 * so there is no registered constant left for this one to be confused with.
 *
 * It stays a display constant regardless. If a per-station hypothesis is ever
 * registered again, it needs its own value under its own name, for the same
 * reason `KP_STORM_THRESHOLD` is kept apart from H4c's trigger.
 */
export const STATION_DISTURBED_NT = 50;

/**
 * One station and what it read, if anything.
 *
 * The disturbance is **separately nullable** because a station being offline is
 * the common case, not an error: measured, 13 of 31 report in a given hour. A
 * station with no reading must draw as *no reading* — one that is down during a
 * storm is exactly the one a reader must not mistake for quiet.
 */
export interface MagnetometerReading {
  station: MagnetometerStation;
  disturbance: StationDisturbance | null;
}
