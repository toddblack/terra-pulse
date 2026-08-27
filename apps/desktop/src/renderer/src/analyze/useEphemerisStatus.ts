import { useEffect, useState } from 'react';
import { EPHEMERIS_KERNEL_BYTES, type EphemerisProgress } from '@terra-pulse/schema';

const IDLE: EphemerisProgress = {
  state: 'idle',
  present: false,
  path: null,
  downloadedBytes: 0,
  totalBytes: EPHEMERIS_KERNEL_BYTES,
  error: null,
};

/**
 * The local ephemeris kernel's state, pulled on mount and pushed thereafter.
 *
 * Two consumers need this and they must not disagree: the prerequisite card
 * renders it, and `AnalyzeShell` gates the Run button on `present`. Subscribing
 * twice would work, but it puts two copies of one fact on screen with no
 * guarantee they update in the same commit — the Run button could enable while
 * the card still reads "not downloaded".
 *
 * **Pull on mount plus push after**, the pattern this codebase already uses for
 * `earthquakes:missed`, `aurora:latest`, `magnetometer:latest` and the
 * large-event alert. Main can finish a download before Analyze is ever opened,
 * and a push alone would have been delivered to nobody.
 */
export function useEphemerisStatus(): EphemerisProgress {
  const [progress, setProgress] = useState<EphemerisProgress>(IDLE);

  useEffect(() => {
    let cancelled = false;

    window.terraPulse.ephemeris
      .status()
      .then((initial) => {
        if (!cancelled) setProgress(initial);
      })
      .catch((error: unknown) => {
        console.error('Could not read the ephemeris kernel status', error);
      });

    const unsubscribe = window.terraPulse.ephemeris.onProgress(setProgress);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return progress;
}
