/**
 * The large-event alert sound.
 *
 * Served from `public/`, so the app is fully functional with no file present —
 * see `public/sounds/README.md`. Every failure path here ends in silence rather
 * than an exception, because a missing or blocked sound must never be the
 * reason an earthquake alert doesn't reach the screen.
 */

/**
 * **Relative, never `/sounds/…`.** A built app loads its page from `file://`,
 * where a leading slash means the drive root: `/sounds/eq-alert.mp3` became
 * `file:///C:/sounds/eq-alert.mp3`, which does not exist, and the player's
 * silent failure did exactly what it was built to do. So no installed copy up
 * to 0.1.4 ever played the alert. `pnpm dev` serves the page from the dev
 * server's root, where both forms work — which is why nobody heard the
 * difference. Found 2026-10-21.
 */
export const ALERT_SOUND_URL = './sounds/eq-alert.mp3';

/**
 * One element, reused.
 *
 * Alerts can land back to back after a network hiccup delivers two polls'
 * worth at once; a fresh element per alert would overlap them into noise.
 * Rewinding instead means the newest alert restarts the sound, matching the
 * banner, which also shows only the newest.
 */
let element: HTMLAudioElement | null = null;

function audio(): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null; // jsdom / SSR
  element ??= new Audio(ALERT_SOUND_URL);
  return element;
}

/**
 * Plays the alert sound if there is one. Never throws, never rejects.
 *
 * Two ordinary reasons this does nothing, neither of them a bug:
 *
 * - **No file.** The mp3 is user-supplied and absent by default.
 * - **Autoplay policy.** Chromium blocks audio until the page has seen a user
 *   gesture. Electron's `autoplayPolicy: 'no-user-gesture-required'` is set in
 *   main for exactly this — an alert that only works after you've clicked
 *   something is not an alert — but the guard stays because the policy is a
 *   browser-level setting and not something to bet an unhandled rejection on.
 */
export function playAlertSound(): void {
  const player = audio();
  if (!player) return;

  // A second alert while the first is still playing restarts it rather than
  // being dropped — `play()` on an already-playing element is a no-op.
  player.currentTime = 0;

  void player.play().catch(() => {
    // Silence is the correct outcome. Not logged: with no file present this
    // would fire on every alert forever, training you to ignore the console.
  });
}
