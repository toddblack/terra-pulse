import { useEffect, useState } from 'react';
import { publishSize } from '../panels/published-size';
import { useQuakeWatchStore } from './useQuakeWatchStore';
import { alertWords } from './watch-labels';
import styles from './WatchAlertBanner.module.css';

/**
 * Explore's top-centre column moves down by this, so the banner never covers
 * the panels there. See `.topCentreColumn` in `App.module.css`.
 */
const publishBannerHeight = publishSize('--watch-banner-height', 'height');

/** How often the countdown redraws while shaking is still to come. */
const COUNTDOWN_TICK_MS = 250;

/**
 * The live watch's alert: a quake the detector has declared, M4.5+ and
 * predicted to be felt at the pin.
 *
 * **This is a warning, unlike `LargeEventBanner`**, which reports a catalogued
 * event after the fact. So it counts down to the S wave, and it is louder: a
 * solid red, at the top of the screen in both modes.
 *
 * The numbers are the detector's own and say so: the magnitude is a running
 * estimate that climbs as more P wave arrives (it reads ~0.3 low at
 * declaration), and the location is its grid search, not the catalogue's.
 * Main pushes updates as the magnitude climbs; the alert itself never repeats.
 */
export function WatchAlertBanner() {
  const alert = useQuakeWatchStore((state) => state.alert);
  const dismissAlert = useQuakeWatchStore((state) => state.dismissAlert);
  const [tickMs, setTickMs] = useState(0);

  // Its own fast clock, only while there is something to count down to — the
  // shared 30 s `useNow` is far too coarse for seconds of warning. Floored at
  // the instant main raised the alert, so a clock last ticked for an earlier
  // alert can never make this one count down from the past.
  const nowMs = alert === null ? tickMs : Math.max(tickMs, alert.alertedAtMs);
  const counting = alert !== null && nowMs < alert.sArrivalAtPinMs;
  useEffect(() => {
    if (alert === null) return;
    if (!counting) return;
    const timer = setInterval(() => {
      setTickMs(Date.now());
    }, COUNTDOWN_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [alert, counting]);

  if (alert === null) return null;
  const words = alertWords(alert, nowMs);

  return (
    <div
      id="watch-alert-banner"
      ref={publishBannerHeight}
      className={words.ahead ? `${styles.banner} ${styles.ahead}` : styles.banner}
      role="alert"
    >
      <span className={styles.badge}>Earthquake</span>
      <span className={styles.magnitude} title="Running estimate from the first stations; it climbs as more arrives">
        {words.magnitude}
      </span>
      <span className={styles.where}>{words.where}</span>
      <span className={styles.countdown}>{words.countdown}</span>
      <span className={styles.intensity} title="Shaking predicted at the pin (Modified Mercalli intensity)">
        intensity {words.intensity}
      </span>
      <button
        type="button"
        id="watch-alert-dismiss"
        className={styles.dismiss}
        aria-label="Dismiss earthquake alert"
        onClick={dismissAlert}
      >
        ×
      </button>
    </div>
  );
}
