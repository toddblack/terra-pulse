import { describe, expect, it, vi } from 'vitest';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { insertEarthquakes, openDatabase, readSeenThrough, writeSeenThrough } from '@terra-pulse/db';
import { collectMissedEvents, markSeenThrough } from './missed-events';

// `registerMissedEventsHandler` imports ipcMain at module load; the functions
// under test never touch Electron.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

function makeEvent(overrides: Partial<EarthquakeEvent> = {}): EarthquakeEvent {
  return {
    id: 'us0001',
    source: 'usgs',
    magnitude: 6.2,
    magnitudeType: 'mww',
    place: 'Somewhere',
    timeUtc: '2026-07-20T12:00:00.000Z',
    updatedUtc: '2026-07-20T12:05:00.000Z',
    longitude: -112.14,
    latitude: 36.05,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: 700,
    url: 'https://example.test',
    ...overrides,
  };
}

describe('collectMissedEvents', () => {
  it('shows nothing on a first-ever launch', () => {
    // No watermark means no absence to report — you cannot have missed
    // something that happened before you owned the app.
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [makeEvent()]);

    expect(collectMissedEvents(db)).toBeNull();
  });

  it('shows nothing after a quiet absence', () => {
    const db = openDatabase(':memory:');
    writeSeenThrough(db, '2026-07-19T00:00:00.000Z');
    insertEarthquakes(db, [makeEvent({ magnitude: 4 })]);

    expect(collectMissedEvents(db)).toBeNull();
  });

  it('reports what arrived since the watermark', () => {
    const db = openDatabase(':memory:');
    writeSeenThrough(db, '2026-07-19T00:00:00.000Z');
    insertEarthquakes(db, [
      makeEvent({ id: 'missed', timeUtc: '2026-07-20T12:00:00.000Z' }),
      makeEvent({ id: 'seen', timeUtc: '2026-07-18T12:00:00.000Z' }),
    ]);

    const missed = collectMissedEvents(db);

    expect(missed?.events.map((e) => e.id)).toEqual(['missed']);
    expect(missed?.totalCount).toBe(1);
    expect(missed?.sinceUtc).toBe('2026-07-19T00:00:00.000Z');
  });

  // The ordering trap. `startEarthquakePolling` fires immediately and that poll
  // calls markSeenThrough — so reading the digest afterwards compares now
  // against now and reports an empty absence on every single launch.
  it('must be read before the watermark advances', () => {
    const db = openDatabase(':memory:');
    writeSeenThrough(db, '2026-07-19T00:00:00.000Z');
    insertEarthquakes(db, [makeEvent({ timeUtc: '2026-07-20T12:00:00.000Z' })]);

    const beforePolling = collectMissedEvents(db);
    markSeenThrough(db, new Date('2026-07-21T00:00:00.000Z'));
    const afterPolling = collectMissedEvents(db);

    expect(beforePolling?.totalCount).toBe(1);
    expect(afterPolling).toBeNull();
  });

  it('advances the watermark to the given instant', () => {
    const db = openDatabase(':memory:');

    markSeenThrough(db, new Date('2026-07-21T09:30:00.000Z'));

    expect(readSeenThrough(db)).toBe('2026-07-21T09:30:00.000Z');
  });
});
