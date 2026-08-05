import type { AftershockSequence as Sequence, EarthquakeEvent } from '@terra-pulse/schema';
import { useAftershockSequence } from './useAftershockSequence';
import {
  barHeightPercents,
  formatElapsed,
  formatRate,
  formatWindow,
  formatYearRanges,
} from './sequence-format';
import styles from './AftershockSequence.module.css';

/**
 * The decay strip: observed **rate** per log-spaced time bin.
 *
 * Rate, not count, and that is the difference between showing the phenomenon
 * and showing the axis. The bins span one day to nearly three years, so counts
 * across them measure bin width — on the real catalogue Tohoku's counts read
 * [182, 236, 204, 223, 289], implying aftershocks get *more* frequent. The same
 * data as a rate is [182, 39.3, 8.9, 1.5, 0.32]: Omori decay, which is what
 * actually happened. See `SequenceBin.perDay`.
 *
 * Still observation. Nothing is fitted to these bars and no curve is drawn
 * through them — the Reasenberg-Jones model that would do that is Analyze's
 * job (§5.9). The raw count stays one hover away so the rate is never the only
 * thing on offer.
 *
 * One series, so no legend — the caption names it. The busiest bin is labelled
 * directly rather than putting a number on all five in a 19rem panel.
 */
function DecayStrip({ bins }: { bins: Sequence['summary']['bins'] }) {
  const heights = barHeightPercents(bins.map((bin) => bin.perDay));
  const busiest = Math.max(0, ...bins.map((bin) => bin.perDay ?? 0));

  return (
    <figure className={styles.strip}>
      <figcaption className={styles.stripCaption}>rate by time since — events/day</figcaption>
      <div className={styles.bars} role="img" aria-label={describeStrip(bins)}>
        {bins.map((bin, index) => {
          const height = heights[index] ?? null;
          return (
            <div key={bin.label} className={styles.barSlot}>
              <span className={styles.barCount}>
                {bin.perDay !== null && bin.perDay === busiest && busiest > 0
                  ? formatRate(bin.perDay)
                  : ''}
              </span>
              <div
                className={styles.barTrack}
                title={`${bin.label}: ${bin.count} ${bin.count === 1 ? 'event' : 'events'}, ${formatRate(bin.perDay)}`}
              >
                {height === null ? (
                  // Left visibly unmeasured. A zero-height bar here would claim
                  // a quiet period in a window that simply hasn't happened yet.
                  <div className={styles.barPending} />
                ) : (
                  <div className={styles.bar} style={{ height: `${height}%` }} />
                )}
              </div>
              <span className={styles.barLabel}>{bin.label}</span>
            </div>
          );
        })}
      </div>
    </figure>
  );
}

/** The strip as a sentence, so nothing is carried by the bars alone. */
function describeStrip(bins: Sequence['summary']['bins']): string {
  return `Aftershock rate by time since the mainshock: ${bins
    .map((bin) => `${bin.label}, ${bin.count} events, ${formatRate(bin.perDay)}`)
    .join('; ')}.`;
}

/**
 * What actually followed a selected event — PROJECT_PLAN §5.9's Explore-safe
 * half.
 *
 * Observation only. It counts catalogued events inside a window fixed by
 * Gardner & Knopoff (1974) and makes no forecast, fits no rate and claims no
 * significance, which is what lets it sit in Explore under non-negotiable #1.
 * The live-event *forecast* §5.9 also describes is a different panel and
 * belongs in Analyze.
 */
export function AftershockSequenceSection({ event }: { event: EarthquakeEvent }) {
  const state = useAftershockSequence(event);

  if (state.status === 'idle') return null;

  return (
    <section className={styles.section} aria-labelledby="sequence-heading">
      <h3 id="sequence-heading" className={styles.heading}>
        What followed
      </h3>

      {state.status === 'loading' && <p className={styles.note}>reading catalogue…</p>}
      {state.status === 'error' && (
        <p className={styles.note}>couldn&rsquo;t read the sequence for this event</p>
      )}
      {state.status === 'ready' && <SequenceBody sequence={state.sequence} />}
    </section>
  );
}

function SequenceBody({ sequence }: { sequence: Sequence }) {
  const { summary, missingYears } = sequence;
  const { count, largest, largestAfterHours, exceededMainshock, elapsedFraction } = summary;

  const stillRunning = elapsedFraction < 1;
  const incomplete = missingYears.length > 0;

  return (
    <>
      {/* The window is stated before the count, because the count is
          meaningless without it — "12 aftershocks" is a different claim inside
          71 km than inside 500 km. */}
      <p className={styles.window}>
        M{summary.minMagnitude}+ within {formatWindow(summary.radiusKm, summary.windowDays)}
      </p>

      {count === 0 ? (
        <p className={styles.count}>
          {incomplete ? 'none in the downloaded catalogue' : 'no recorded aftershocks'}
        </p>
      ) : (
        <p className={styles.count}>
          <span className={styles.countNumber}>{count.toLocaleString()}</span>{' '}
          {count === 1 ? 'aftershock' : 'aftershocks'}
          {incomplete && <span className={styles.qualifier}> at least</span>}
        </p>
      )}

      {largest !== null && largestAfterHours !== null && (
        <p className={styles.largest}>
          largest M{largest.magnitude.toFixed(1)}, {formatElapsed(largestAfterHours)} after
        </p>
      )}

      {count > 0 && <DecayStrip bins={summary.bins} />}

      {/* Not a footnote. Gardner-Knopoff calls the largest event of a cluster
          the mainshock, so when something bigger followed, the window above was
          sized to the wrong magnitude and this panel is describing a foreshock's
          sequence. Said plainly rather than left for the reader to infer from
          the magnitudes. */}
      {exceededMainshock && largest !== null && (
        <p className={styles.foreshockFlag}>
          An M{largest.magnitude.toFixed(1)} followed — larger than this event, so this was a
          foreshock and the window above is sized to the smaller shock.
        </p>
      )}

      {stillRunning && (
        <p className={styles.caveat}>
          Sequence still developing — {Math.round(elapsedFraction * 100)}% of the window has
          elapsed.
        </p>
      )}

      {/* A zero from an undownloaded archive and a real zero are the same
          number. This is the only thing that tells them apart. */}
      {incomplete && (
        <p className={styles.caveat}>
          No archive data for {formatYearRanges(missingYears)} — this is a lower bound.
        </p>
      )}
    </>
  );
}
