import type { QuakeWatchStatus } from '@terra-pulse/schema';
import { isWatching, useQuakeWatchStore } from './useQuakeWatchStore';
import { watchDetail } from './watch-labels';
import styles from './WatchHereButton.module.css';

/** A map pin with a ring at its foot — "a place being watched", like the globe marker. */
function PinIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 12 14" aria-hidden="true">
      <path d="M6 1a3.6 3.6 0 0 0-3.6 3.6C2.4 7.3 6 10.6 6 10.6s3.6-3.3 3.6-6A3.6 3.6 0 0 0 6 1Z" />
      <circle className={styles.iconHole} cx="6" cy="4.6" r="1.25" />
      <ellipse className={styles.iconRing} cx="6" cy="12.3" rx="3.4" ry="1.1" />
    </svg>
  );
}

/** What the button says once the pick *is* the pin. */
function pinnedVerdict(status: QuakeWatchStatus): { ok: boolean; text: string; detail: string } {
  const detail = watchDetail(status);
  if (status.state === 'starting') return { ok: true, text: 'Starting watch…', detail };
  if (status.state === 'unavailable') return { ok: false, text: 'Can’t watch here', detail };
  if (status.limit === 'too-far') return { ok: true, text: 'Watching (limited)', detail };
  return { ok: true, text: 'Watching this spot', detail };
}

/**
 * Turns the waveform tab's picked spot into the live watch's pin.
 *
 * **Lives in the waveform panel, and only there** — the user's call
 * (2026-10-08), after it shipped first in the location panel and the quake
 * inspector and felt disconnected. The flow it serves: pick spots around the
 * globe to look at their traces, find one worth keeping an eye on, make it the
 * watch, then carry on picking elsewhere. The pick and the watch are separate
 * connections, so moving the pick never moves the watch.
 *
 * **It looks unlike everything else in the panel on purpose**: emerald and
 * filled, the watch's colour on the globe and the dock chip. Every other
 * control here changes what you are *looking at*; this one starts something
 * that keeps running, and alerts, after you look away.
 *
 * Disabled — with the reason as its tooltip — when there is no single spot to
 * watch: a preset region, or the picked tab before a pick.
 */
export function WatchHereButton({
  point,
  label,
  disabledReason,
}: {
  point: { latitude: number; longitude: number } | null;
  /** Names the pin in the dock chip and in alerts. */
  label: string;
  /** Why there is nothing to watch; null when there is. */
  disabledReason: string | null;
}) {
  const status = useQuakeWatchStore((state) => state.status);
  const watch = useQuakeWatchStore((state) => state.watch);
  const stopWatching = useQuakeWatchStore((state) => state.stopWatching);
  const error = useQuakeWatchStore((state) => state.error);

  if (point !== null && disabledReason === null && isWatching(status, point)) {
    // Main's verdict on this pin, not just "it is pinned": a spot with no
    // station in reach is pinned and watching nothing, and the button the
    // reader just pressed is where they look to find that out.
    const verdict = pinnedVerdict(status);
    return (
      <span id="watch-here" className={verdict.ok ? styles.watching : styles.cannot} title={verdict.detail}>
        <PinIcon />
        {verdict.text}
        <button
          type="button"
          className={styles.stop}
          onClick={stopWatching}
          title="Stop watching and remove the pin"
          aria-label="Stop watching and remove the pin"
        >
          {verdict.ok ? 'stop' : 'remove'}
        </button>
      </span>
    );
  }

  const disabled = point === null || disabledReason !== null;
  return (
    <button
      type="button"
      id="watch-here"
      className={styles.button}
      disabled={disabled}
      title={
        disabled
          ? (disabledReason ?? 'Pick a spot on the globe first')
          : error !== null
            ? `Could not start the watch: ${error}`
            : status.pin === null
              ? 'Keep watching the stations around this spot while the app is open, and alert on an M4.5+ quake predicted to be felt here'
              : `Move the watch here from ${status.pin.label}. One spot is watched at a time.`
      }
      onClick={() => {
        if (point !== null) watch({ latitude: point.latitude, longitude: point.longitude, label });
      }}
    >
      <PinIcon />
      {status.pin === null ? 'Watch this spot' : 'Move watch here'}
    </button>
  );
}
