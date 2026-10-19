import { useEffect } from 'react';
import { useUpdateStore } from './useUpdateStore';

/**
 * Keeps the store in step with main's update check, from `App` so the version
 * label shows in either mode.
 *
 * Subscribe, then pull — the shape every main-held state here uses, because a
 * push sent before the renderer subscribed reaches nobody. The first check
 * waits 15 s after launch, so in practice the pull is what lands first.
 */
export function useUpdateSync(): void {
  const setStatus = useUpdateStore((state) => state.setStatus);

  useEffect(() => {
    const unsubscribe = window.terraPulse.updates.onStatus(setStatus);
    window.terraPulse.updates
      .status()
      .then(setStatus)
      .catch((error: unknown) => {
        console.error('Could not read the update status', error);
      });
    return unsubscribe;
  }, [setStatus]);
}
