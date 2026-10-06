import { describe, expect, it } from 'vitest';
import {
  INITIAL_DOCK,
  isDockShowing,
  pressDockTab,
  showDockTab,
  toggleDockOpen,
  type DockState,
} from './dock-state';

describe('dock state', () => {
  it('opens on the timeline, with the stream never asked for', () => {
    // A launch must open no socket: the waveform stream starts from this latch.
    expect(INITIAL_DOCK).toEqual({ tab: 'timeline', open: true, waveformsStarted: false });
    expect(isDockShowing(INITIAL_DOCK, 'timeline')).toBe(true);
    expect(isDockShowing(INITIAL_DOCK, 'waveforms')).toBe(false);
  });

  it('minimises when the tab already showing is pressed', () => {
    const minimised = pressDockTab(INITIAL_DOCK, 'timeline');
    expect(minimised.open).toBe(false);
    expect(minimised.tab).toBe('timeline');
    // Pressing it again restores rather than leaving the dock stuck shut.
    expect(isDockShowing(pressDockTab(minimised, 'timeline'), 'timeline')).toBe(true);
  });

  it('switches to the other tab and opens, from open or minimised', () => {
    const minimised = pressDockTab(INITIAL_DOCK, 'timeline');
    for (const from of [INITIAL_DOCK, minimised]) {
      expect(isDockShowing(pressDockTab(from, 'waveforms'), 'waveforms')).toBe(true);
    }
  });

  it('latches the stream on the first showing of the waveform tab, and keeps it', () => {
    const shown = pressDockTab(INITIAL_DOCK, 'waveforms');
    expect(shown.waveformsStarted).toBe(true);
    // Minimising or going back to the timeline must not stop the stream —
    // reopening should show the last two minutes, not an empty panel.
    expect(pressDockTab(shown, 'waveforms').waveformsStarted).toBe(true);
    expect(pressDockTab(shown, 'timeline').waveformsStarted).toBe(true);
  });

  it('does not start the stream for a timeline-only session', () => {
    let state: DockState = INITIAL_DOCK;
    state = pressDockTab(state, 'timeline');
    state = toggleDockOpen(state);
    state = showDockTab(state, 'timeline');
    expect(state.waveformsStarted).toBe(false);
  });

  it('restoring a minimised waveform tab is a showing too', () => {
    const hidden: DockState = { tab: 'waveforms', open: false, waveformsStarted: false };
    expect(toggleDockOpen(hidden).waveformsStarted).toBe(true);
  });

  it('never minimises from outside the dock', () => {
    // The inspector's "Stations" button: a second press must not hide the very
    // panel it was pressed to show.
    const shown = showDockTab(INITIAL_DOCK, 'waveforms');
    expect(isDockShowing(showDockTab(shown, 'waveforms'), 'waveforms')).toBe(true);
    expect(showDockTab(shown, 'waveforms')).toBe(shown);
  });
});
