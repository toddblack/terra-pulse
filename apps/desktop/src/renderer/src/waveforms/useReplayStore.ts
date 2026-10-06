import { create } from 'zustand';
import type { QuakeReplay, QuakeReplayProgress, QuakeReplayRequest } from '@terra-pulse/schema';
import { advance, startPlayback, type Playback, type ReplaySpeed } from './replay-playback';

export type ReplayLoad =
  | { status: 'loading'; progress: QuakeReplayProgress | null }
  | { status: 'ready'; replay: QuakeReplay }
  | { status: 'error'; reason: string };

interface ReplayState {
  /** The quake being replayed, or null when the waveform tab shows live. */
  request: QuakeReplayRequest | null;
  load: ReplayLoad | null;
  playback: Playback;
  /**
   * What last moved the clock. The alert sound plays only when *playback*
   * crosses the alert — a scrub across it must stay silent.
   */
  lastMove: 'tick' | 'seek';

  start: (request: QuakeReplayRequest) => void;
  /** Back to live. The live stream never stopped. */
  close: () => void;
  noteProgress: (progress: QuakeReplayProgress) => void;
  play: () => void;
  pause: () => void;
  setSpeed: (speed: ReplaySpeed) => void;
  seek: (positionMs: number) => void;
  tick: (dtMs: number) => void;
}

const IDLE_PLAYBACK: Playback = { playing: false, speed: 1, positionMs: 0 };

/** The IPC error wrapper adds "Error invoking remote method …: Error: "; keep what main said. */
function reasonOf(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}

/**
 * The quake replay on screen, if any.
 *
 * **Results are stored against the request they answer.** Clicking through a
 * few quakes fires overlapping loads with no ordering guarantee, and the
 * failure would look entirely normal — one quake's replay under another's
 * heading. A reply whose event is not the current request is dropped, the
 * `useAftershockSequence` lesson.
 */
export const useReplayStore = create<ReplayState>((set, get) => ({
  request: null,
  load: null,
  playback: IDLE_PLAYBACK,
  lastMove: 'seek',

  start: (request) => {
    set({ request, load: { status: 'loading', progress: null }, playback: IDLE_PLAYBACK, lastMove: 'seek' });
    window.terraPulse.quakeReplay.start(request).then(
      (replay) => {
        if (get().request?.eventId !== replay.request.eventId) return;
        set({ load: { status: 'ready', replay }, playback: startPlayback(replay), lastMove: 'seek' });
      },
      (cause: unknown) => {
        // Superseded by a newer start: that one owns the panel now.
        if (get().request?.eventId !== request.eventId) return;
        const reason = reasonOf(cause);
        if (reason === 'replay superseded') return;
        set({ load: { status: 'error', reason } });
      },
    );
  },

  close: () => {
    void window.terraPulse.quakeReplay.cancel();
    set({ request: null, load: null, playback: IDLE_PLAYBACK });
  },

  noteProgress: (progress) => {
    const { request, load } = get();
    if (request?.eventId !== progress.eventId || load?.status !== 'loading') return;
    set({ load: { status: 'loading', progress } });
  },

  play: () => {
    const { load, playback } = get();
    if (load?.status !== 'ready') return;
    // Play from the end restarts — the obvious meaning of pressing play there.
    const atEnd = playback.positionMs >= load.replay.windowEndMs;
    set({
      playback: { ...playback, playing: true, positionMs: atEnd ? load.replay.windowStartMs : playback.positionMs },
      lastMove: atEnd ? 'seek' : get().lastMove,
    });
  },

  pause: () => set((state) => ({ playback: { ...state.playback, playing: false } })),

  setSpeed: (speed) => set((state) => ({ playback: { ...state.playback, speed } })),

  seek: (positionMs) => {
    const { load } = get();
    if (load?.status !== 'ready') return;
    const clamped = Math.max(load.replay.windowStartMs, Math.min(load.replay.windowEndMs, positionMs));
    set((state) => ({ playback: { ...state.playback, positionMs: clamped }, lastMove: 'seek' }));
  },

  tick: (dtMs) => {
    const { load, playback } = get();
    if (load?.status !== 'ready' || !playback.playing) return;
    set({ playback: advance(playback, dtMs, load.replay.windowEndMs), lastMove: 'tick' });
  },
}));

/** Whether a replay is open — the waveform tab shows it instead of live. */
export function selectReplayOpen(state: Pick<ReplayState, 'request'>): boolean {
  return state.request !== null;
}
