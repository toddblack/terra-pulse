/**
 * The bottom dock's state: which tab it holds, whether it is open, and whether
 * the waveform stream has ever been asked for. Pure, so every rule is a test.
 *
 * The dock replaced two separate surfaces — the time scrubber, which sat at the
 * bottom of Explore, and the waveform *mode*, which unmounted Explore entirely.
 * In the mode, the earthquakes stayed drawn but nothing about them could be
 * read: no hover, no inspector, no range controls. Folding waveforms into a tab
 * here is what keeps all of that on screen beside the traces.
 */

export type DockTab = 'timeline' | 'waveforms';

export interface DockState {
  tab: DockTab;
  /** False when minimised to just its tab strip, for a clear view of the globe. */
  open: boolean;
  /**
   * Latched true the first time the waveform tab is shown, and never cleared.
   *
   * It is what starts the live stream, and it is deliberately a latch rather
   * than "is the tab showing": the stream keeps running while the dock is
   * minimised or on the timeline, so reopening shows the last two minutes at
   * once instead of an empty panel filling up. A launch never sets it, so a
   * launch still opens no socket.
   */
  waveformsStarted: boolean;
}

export const INITIAL_DOCK: DockState = { tab: 'timeline', open: true, waveformsStarted: false };

function latch(state: DockState): DockState {
  return state.open && state.tab === 'waveforms' && !state.waveformsStarted
    ? { ...state, waveformsStarted: true }
    : state;
}

/**
 * A press on a tab. On the tab already showing, it minimises — the tab strip
 * is the dock's only chrome, so "click the thing that's open to put it away"
 * is the one gesture that needs no extra button to discover. Anything else
 * opens that tab.
 */
export function pressDockTab(state: DockState, tab: DockTab): DockState {
  if (state.open && state.tab === tab) return { ...state, open: false };
  return latch({ ...state, tab, open: true });
}

/**
 * Opens a tab and never minimises — for callers outside the dock, like the
 * inspector's "stations near this quake", where a second press must not hide
 * the very thing it was pressed to show.
 */
export function showDockTab(state: DockState, tab: DockTab): DockState {
  if (state.open && state.tab === tab) return state;
  return latch({ ...state, tab, open: true });
}

/** The minimise/restore control: the tab is kept, only visibility flips. */
export function toggleDockOpen(state: DockState): DockState {
  return latch({ ...state, open: !state.open });
}

/** Whether `tab` is the one on screen right now. */
export function isDockShowing(state: DockState, tab: DockTab): boolean {
  return state.open && state.tab === tab;
}
