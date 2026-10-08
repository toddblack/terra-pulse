import { useEffect } from 'react';
import { playAlertSound } from '../audio/alert-sound';
import { useQuakeWatchStore } from './useQuakeWatchStore';

/**
 * Keeps the store in step with main's watch, from `App` — above both shells,
 * because an alert must reach a reader who is in Analyze mode.
 *
 * Subscribe, then pull: the pull covers anything pushed before this renderer
 * existed (a launch with a stored pin starts the watch before the window has
 * painted, and §5.8 learned that a push then reaches nobody). Something pushed
 * between the two arrives twice, with the same content, which is harmless.
 */
export function useQuakeWatchSync(): void {
  const setStatus = useQuakeWatchStore((state) => state.setStatus);
  const showAlert = useQuakeWatchStore((state) => state.showAlert);
  const updateAlert = useQuakeWatchStore((state) => state.updateAlert);

  useEffect(() => {
    const unsubscribe = window.terraPulse.quakeWatch.onStatus(setStatus);
    window.terraPulse.quakeWatch
      .status()
      .then(setStatus)
      .catch((error: unknown) => {
        console.error('Could not read the watch status', error);
      });
    return unsubscribe;
  }, [setStatus]);

  useEffect(() => {
    const offAlert = window.terraPulse.quakeWatch.onAlert((alert) => {
      showAlert(alert);
      playAlertSound();
    });
    const offUpdate = window.terraPulse.quakeWatch.onAlertUpdated(updateAlert);
    window.terraPulse.quakeWatch
      .currentAlert()
      .then((alert) => {
        if (alert === null) return;
        showAlert(alert);
        // A retained alert is sounded only while its shaking is still to come.
        // After a reload, a chime for a quake that has already passed is noise.
        if (Date.now() < alert.sArrivalAtPinMs) playAlertSound();
      })
      .catch((error: unknown) => {
        console.error('Could not read the current watch alert', error);
      });
    return () => {
      offAlert();
      offUpdate();
    };
  }, [showAlert, updateAlert]);
}
