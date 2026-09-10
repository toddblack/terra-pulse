import {
  forecastAftershocks,
  FORECAST_VERIFIABLE_MAGNITUDE,
  isForecastEligible,
  RJ_A,
  RJ_B,
  RJ_C_DAYS,
  RJ_P,
  type EarthquakeEvent,
  type ForecastWindow,
} from '@terra-pulse/schema';
import { useNow } from '../globe/useNow';
import styles from './AftershockForecast.module.css';

/**
 * §5.9's model half: how many more aftershocks to expect, from now.
 *
 * The sibling of `AftershockSequence` — that one reports what the catalogue
 * *recorded*, this one reports what an empirical law *implies*. They sit next
 * to each other in the inspector on purpose, because the pair is the honest
 * picture; but they must never look like the same kind of statement, which is
 * what most of the styling here is for.
 *
 * ## The layout is USGS's own
 *
 * Magnitude bins as rows, time windows as columns, a probability and a count
 * range in each cell. Registered as **M1b**. It replaced a single M5.0 forecast
 * that was right and useless: an M5.5 expects 0.015 M5+ aftershocks in a day,
 * so every cell read "0–0" and "<0.1". Binning is where the information lives —
 * on a live USGS forecast for an M5.3 the one-week row reads M3+ 17.3% against
 * M5+ 0.2%.
 *
 * Adopting a presentation many people have already seen on USGS event pages
 * beats inventing one, and it makes this panel directly comparable to theirs.
 *
 * ## Why this is allowed in Explore at all
 *
 * Non-negotiable #1 bars *significance claims* from Explore — p-values,
 * correlation coefficients, "this looks related". A forecast is none of those,
 * and §5.9 says so explicitly. The precedent is already here: the
 * `magnetopause` layer draws model output in Explore behind a `(model)` label.
 *
 * What that costs is labelling, and the cost is paid in three places: the
 * section is titled as a forecast, the panel carries a `model` badge, and the
 * registered parameters are printed so the reader can see the numbers were
 * fixed in advance rather than chosen to fit.
 */
export function AftershockForecastBody({ event }: { event: EarthquakeEvent }) {
  // The clock lives here rather than in the inspector so the 30 s tick
  // re-renders one section instead of the whole panel — the question
  // CLAUDE.md's inspector note says to ask before adding `useNow` anywhere.
  // Nothing here refetches; the forecast is closed-form arithmetic.
  const nowMs = useNow();
  const eventMs = Date.parse(event.timeUtc);

  if (!Number.isFinite(eventMs)) return null;

  const forecast = forecastAftershocks(event.magnitude, eventMs, nowMs);
  const windows = forecast.rows[0]?.windows ?? [];

  return (
    <div className={styles.body}>
      <p className={styles.lede}>
        <span className={styles.badge}>model</span> Chance of at least one more
        earthquake near this one, and how many to expect.
      </p>

      <table className={styles.grid}>
        <thead>
          <tr>
            <th scope="col" className={styles.magHead}>
              Mag
            </th>
            {windows.map((window) => (
              <th key={window.hours} scope="col">
                {formatWindow(window.hours)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {forecast.rows.map((row) => (
            <tr key={row.magnitude}>
              <th scope="row" className={styles.magHead}>
                M{row.magnitude.toFixed(0)}+
                {/* The two smallest bins are below this app's own completeness,
                    so they can never be checked against the observed-sequence
                    panel directly above. Marked rather than hidden: they carry
                    most of the information, and quietly dropping them would be
                    the empty-panel problem all over again. */}
                {!row.verifiable && (
                  <span className={styles.unverifiable} aria-hidden="true">
                    *
                  </span>
                )}
              </th>
              {row.windows.map((window) => (
                <td key={window.hours}>
                  <Cell window={window} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <p className={styles.footnote}>
        <span aria-hidden="true">*</span> below this catalogue’s completeness
        (M{FORECAST_VERIFIABLE_MAGNITUDE.toFixed(1)}) — forecast only, not
        checkable against the sequence above.
      </p>

      {/* §5.9: this figure is "the one people misread catastrophically" and may
          appear only with its framing attached, never as a bare percentage.
          So it is a sentence, not a cell in the grid — a cell reading "5%" is
          exactly the thing that gets screenshotted. */}
      <p className={styles.foreshock}>
        There is roughly a <strong>{formatPercent(forecast.probabilityOfLarger)}</strong> chance
        that something <em>larger</em> than this M{event.magnitude.toFixed(1)} follows within a
        month — which would make this one a foreshock. That is the ordinary
        background risk after any earthquake, not a warning about this one: the
        model gives the same figure for any earthquake this long ago, whatever
        its size. It falls as the days pass.
      </p>

      <p className={styles.caveat}>
        Generic global parameters (a {RJ_A}, b {RJ_B.toFixed(1)}, p {RJ_P}, c {RJ_C_DAYS} d), not
        fitted to this sequence. Registered as M1/M1b before use. Productivity
        varies by tectonic setting by roughly a factor of ten, and the ranges
        shown cover only the randomness of the count, not uncertainty in the
        parameters — so USGS’s published ranges for the same sequence would be
        wider than these.
      </p>
    </div>
  );
}

/**
 * One cell: the probability of at least one, over the 95% count range.
 *
 * The probability leads because it is the number that stays meaningful at every
 * magnitude. §5.9 requires an interval rather than a point estimate, so the
 * count appears as a range and never as a bare mean — and where the range is
 * "0–0" the probability is still saying something useful, which is the whole
 * reason M1b bins by magnitude.
 */
function Cell({ window }: { window: ForecastWindow }) {
  const negligible = window.chanceOfAny < 0.005;

  return (
    <span className={negligible ? `${styles.cell} ${styles.cellQuiet}` : styles.cell}>
      <span className={styles.chance}>{formatPercent(window.chanceOfAny)}</span>
      <span className={styles.range}>
        {window.low}–{window.high}
      </span>
    </span>
  );
}

/** Whether the forecast section is offered for this event at all. */
export function hasForecastPanel(event: EarthquakeEvent, nowMs: number): boolean {
  const eventMs = Date.parse(event.timeUtc);
  return Number.isFinite(eventMs) && isForecastEligible(event.magnitude, eventMs, nowMs);
}

function formatPercent(value: number): string {
  const percent = value * 100;
  if (percent < 0.5) return '<1%';
  if (percent > 99) return '>99%';
  return `${percent.toFixed(0)}%`;
}

/** `24 h` / `7 d` / `30 d` — hours below two days, days above. */
function formatWindow(hours: number): string {
  return hours < 48 ? `${String(hours)} h` : `${String(hours / 24)} d`;
}
