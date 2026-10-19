import { create } from 'zustand';
import type { UpdateStatus } from '@terra-pulse/schema';

/**
 * A mirror of main's update check plus the four things the About panel asks
 * of it. Main owns the request, the stored switch and the dismissed version.
 */
interface UpdateState {
  /** Null until the first pull lands — the version label waits for it. */
  status: UpdateStatus | null;
  setStatus: (status: UpdateStatus) => void;
  check: () => void;
  setEnabled: (enabled: boolean) => void;
  dismiss: (version: string) => void;
  openRelease: () => void;
}

function logFailure(what: string) {
  return (cause: unknown) => {
    console.error(`Update check: could not ${what}`, cause);
  };
}

export const useUpdateStore = create<UpdateState>((set) => ({
  status: null,
  setStatus: (status) => {
    set({ status });
  },
  check: () => {
    window.terraPulse.updates.check().then((status) => set({ status }), logFailure('check'));
  },
  setEnabled: (enabled) => {
    window.terraPulse.updates.setEnabled(enabled).then((status) => set({ status }), logFailure('change the switch'));
  },
  dismiss: (version) => {
    window.terraPulse.updates.dismiss(version).then((status) => set({ status }), logFailure('dismiss'));
  },
  openRelease: () => {
    window.terraPulse.updates.openRelease().catch(logFailure('open the release page'));
  },
}));
