import { create } from 'zustand';
import { WATCH_STATUS_OFF, type QuakeWatchAlert, type QuakeWatchStatus, type WatchPin } from '@terra-pulse/schema';

/**
 * What the renderer knows of the live watch: main's status, and the alert on
 * screen. Main owns everything else — the stream, the detector, the decision
 * to alert — so this is a mirror plus two requests.
 *
 * Module-level and mounted from `App`, not Explore: a watch alert has to reach
 * someone in Analyze mode too, and Explore unmounts there.
 */
interface QuakeWatchState {
  status: QuakeWatchStatus;
  alert: QuakeWatchAlert | null;
  /** The last start or stop main refused, for the button that asked. */
  error: string | null;

  setStatus: (status: QuakeWatchStatus) => void;
  /** A new alert replaces whatever was on screen: it is the one still unfolding. */
  showAlert: (alert: QuakeWatchAlert) => void;
  /** The alert on screen with a climbed magnitude. Ignored for any other alert. */
  updateAlert: (alert: QuakeWatchAlert) => void;
  dismissAlert: () => void;
  watch: (pin: WatchPin) => void;
  stopWatching: () => void;
  /**
   * Asks main for a test alert. Nothing is shown from the reply: the alert
   * arrives the way a real one does, pushed and sounded by `useQuakeWatchSync`,
   * which is the path being tested.
   */
  testAlert: () => void;
}

/** The IPC error wrapper adds "Error invoking remote method …: Error: "; keep what main said. */
function reasonOf(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}

export const useQuakeWatchStore = create<QuakeWatchState>((set, get) => ({
  status: WATCH_STATUS_OFF,
  alert: null,
  error: null,

  setStatus: (status) => {
    set({ status });
  },
  showAlert: (alert) => {
    set({ alert });
  },
  updateAlert: (alert) => {
    if (get().alert?.id === alert.id) set({ alert });
  },
  dismissAlert: () => {
    set({ alert: null });
    // Main keeps its copy for a renderer that mounts later; clearing it is what
    // stops a dismissed alert coming back after a reload.
    void window.terraPulse.quakeWatch.dismissAlert();
  },
  watch: (pin) => {
    set({ error: null });
    window.terraPulse.quakeWatch
      .start(pin)
      .then((status) => {
        set({ status });
      })
      .catch((cause: unknown) => {
        set({ error: reasonOf(cause) });
      });
  },
  stopWatching: () => {
    set({ error: null });
    window.terraPulse.quakeWatch
      .stop()
      .then((status) => {
        set({ status });
      })
      .catch((cause: unknown) => {
        set({ error: reasonOf(cause) });
      });
  },
  testAlert: () => {
    set({ error: null });
    window.terraPulse.quakeWatch.testAlert().catch((cause: unknown) => {
      set({ error: reasonOf(cause) });
    });
  },
}));

/** Whether the pin sits on this spot — to the ~10 m the coordinates are rounded to on screen. */
export function isWatching(status: QuakeWatchStatus, point: { latitude: number; longitude: number }): boolean {
  const pin = status.pin;
  if (pin === null) return false;
  return Math.abs(pin.latitude - point.latitude) < 1e-4 && Math.abs(pin.longitude - point.longitude) < 1e-4;
}
