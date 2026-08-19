import { useEffect, useState } from 'react';
import type { EngineStatus } from '@terra-pulse/schema';

/** The local Python engine process's own status — starting, ready, or
 * unavailable and why. Read once on mount, then followed live. */
export function useEngineStatus(): EngineStatus {
  const [status, setStatus] = useState<EngineStatus>({ state: 'starting' });

  useEffect(() => {
    window.terraPulse.analysis
      .status()
      .then(setStatus)
      .catch((error: unknown) => {
        console.error('Could not read engine status', error);
      });

    return window.terraPulse.analysis.onEngineStatus(setStatus);
  }, []);

  return status;
}
