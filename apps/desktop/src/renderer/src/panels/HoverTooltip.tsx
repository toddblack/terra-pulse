import { useGlobeStore } from '../state/useGlobeStore';
import { useNow } from '../globe/useNow';
import { formatAgoFrom } from './time-labels';
import styles from './HoverTooltip.module.css';

/**
 * What the pointer is over, drawn beside it.
 *
 * Follows the cursor rather than docking, because its whole job is to identify
 * the thing directly under the pointer — a docked readout makes you look away
 * from what you are pointing at.
 *
 * Positioned with a transform so it never sits *under* the cursor (which would
 * make it flicker as the pointer picks the tooltip instead of the globe) and
 * flips to the other side near the right edge so it can't be clipped.
 */
export function HoverTooltip() {
  const hover = useGlobeStore((state) => state.hover);
  // Measured from the wall clock rather than the playhead, matching the event
  // list — the two describe the same events and must not disagree. Never
  // `Date.now()` in render: nothing re-renders when a clock ticks.
  const nowMs = useNow();

  if (hover === null) return null;

  const age = formatAgoFrom(hover.target.timeUtc, nowMs);

  // Flip before the tooltip would overflow. 260px is its max width plus the
  // offset; measuring the real element would need a layout pass per mouse move.
  const flip = hover.x > window.innerWidth - 260;

  return (
    <div
      className={styles.tooltip}
      data-kind={hover.target.kind}
      style={{
        left: `${hover.x}px`,
        top: `${hover.y}px`,
        transform: flip ? 'translate(calc(-100% - 14px), -50%)' : 'translate(14px, -50%)',
      }}
      // Purely informational and duplicated by the panel a click opens, so it
      // is hidden from assistive tech rather than announced on every pixel of
      // pointer movement.
      aria-hidden="true"
    >
      {/* Title left, age right. The age is short and fixed-width-ish, so it
          sits opposite rather than after the title — which keeps it in the same
          place whatever the magnitude, and leaves the long place string a full
          line of its own below. */}
      <span className={styles.head}>
        <span className={styles.title}>{hover.target.title}</span>
        {age !== null && <span className={styles.age}>{age}</span>}
      </span>
      {hover.target.detail !== null && (
        <span className={styles.detail}>{hover.target.detail}</span>
      )}
    </div>
  );
}
