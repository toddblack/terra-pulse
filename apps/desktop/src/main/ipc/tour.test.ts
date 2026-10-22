import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { TOUR_SEEN_KEY, createTourState } from './tour';

function setUp(freshInstall: boolean, stored: Record<string, string> = {}) {
  const state = new Map(Object.entries(stored));
  const tour = createTourState({
    freshInstall,
    currentVersion: '0.1.6',
    readState: (key) => state.get(key) ?? null,
    writeState: (key, value) => state.set(key, value),
  });
  return { tour, state };
}

describe('createTourState', () => {
  it('reports a fresh install with no tour history', () => {
    expect(setUp(true).tour.status()).toEqual({ freshInstall: true, seenVersion: null, currentVersion: '0.1.6' });
  });

  it('reads the stored version', () => {
    expect(setUp(false, { [TOUR_SEEN_KEY]: '0.1.5' }).tour.status().seenVersion).toBe('0.1.5');
  });

  it('records its own version when marked, whatever was there', () => {
    const { tour, state } = setUp(true, { [TOUR_SEEN_KEY]: '0.1.5' });
    expect(tour.markSeen().seenVersion).toBe('0.1.6');
    expect(state.get(TOUR_SEEN_KEY)).toBe('0.1.6');
  });

  it('keeps reporting a fresh install after marking — the flag is a fact about launch', () => {
    const { tour } = setUp(true);
    tour.markSeen();
    expect(tour.status().freshInstall).toBe(true);
  });
});
