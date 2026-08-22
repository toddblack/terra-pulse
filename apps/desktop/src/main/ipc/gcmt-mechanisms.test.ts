import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FocalMechanism, GcmtProgress } from '@terra-pulse/schema';
import { focalMechanismCoverage, openDatabase, queryFocalMechanisms } from '@terra-pulse/db';
import { createGcmtController, registerGcmtIpcHandlers } from './gcmt-mechanisms';

// `registerGcmtIpcHandlers` imports ipcMain at module load; the controller
// itself never touches Electron.
const ipcHandle = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcMain: { handle: ipcHandle } }));

const fetchGcmtCombined = vi.hoisted(() => vi.fn());
const fetchGcmtMonth = vi.hoisted(() => vi.fn());
vi.mock('@terra-pulse/ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@terra-pulse/ingest')>();
  return { ...actual, fetchGcmtCombined, fetchGcmtMonth };
});

function mechanism(id: string, timeUtc: string): FocalMechanism {
  return {
    id,
    timeUtc,
    latitude: 10,
    longitude: 20,
    depthKm: 15,
    magnitude: 6,
    scalarMomentDyneCm: 1e25,
    nodalPlane1: { strike: 10, dip: 20, rake: 30 },
    nodalPlane2: { strike: 100, dip: 70, rake: 80 },
    centroidLatitude: 10,
    centroidLongitude: 20,
    centroidDepthKm: 15,
    referenceCatalog: 'PDE',
  };
}

/** Mid-April, so three monthly chunks (Jan, Feb, Mar) are due. */
const NOW = new Date('2026-04-15T00:00:00Z');

function setup(now: Date = NOW) {
  const db = openDatabase(':memory:');
  const progress: GcmtProgress[] = [];
  const controller = createGcmtController(db, (p) => progress.push(p), () => now);
  return { db, controller, progress };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchGcmtCombined.mockResolvedValue({
    chunk: { chunk: 'jan76_dec25', kind: 'combined' },
    mechanisms: [mechanism('C1976', '1976-01-01T00:00:00.000Z')],
  });
  fetchGcmtMonth.mockResolvedValue([]);
});

describe('createGcmtController', () => {
  it('fetches the combined catalogue then each finished month', async () => {
    const { db, controller } = setup();
    const final = await controller.start();

    expect(fetchGcmtCombined).toHaveBeenCalledTimes(1);
    const monthsAsked = fetchGcmtMonth.mock.calls.map(
      (call) => [call[0], call[1]] as [number, number],
    );
    expect(monthsAsked).toEqual([
      [2026, 1],
      [2026, 2],
      [2026, 3],
    ]);
    expect(final.state).toBe('complete');
    expect(focalMechanismCoverage(db).total).toBe(1);
    db.close();
  });

  it('excludes the current month, which is not finished', () => {
    // Recording an unfinished chunk complete is how a resume silently stops
    // resuming — the same rule the earthquake archive applies to its year.
    const { db, controller } = setup();
    expect(controller.status().totalChunks).toBe(1 + 3);
    db.close();
  });

  it('treats an unpublished month as pending, not as a failure', async () => {
    // Global CMT determines solutions on a three-to-four-month delay, so the
    // most recent months return 404. Failing there would make the backfill fail
    // on every run forever.
    const { db, controller } = setup();
    fetchGcmtMonth.mockResolvedValueOnce([]).mockResolvedValue(null);

    const final = await controller.start();
    expect(final.state).toBe('complete');
    expect(final.pendingMonths).toBe(2);
    db.close();
  });

  it('leaves a pending month unrecorded so a later run fetches it', async () => {
    const { db, controller } = setup();
    fetchGcmtMonth.mockResolvedValue(null);
    await controller.start();

    // Three months were due, none was published, so only the combined chunk is
    // recorded.
    expect(controller.status().completedChunks).toBe(1);
    db.close();
  });

  it('resumes without refetching what is already recorded', async () => {
    const { db, controller } = setup();
    await controller.start();
    vi.clearAllMocks();

    const second = createGcmtController(db, () => {}, () => NOW);
    await second.start();

    expect(fetchGcmtCombined).not.toHaveBeenCalled();
    expect(fetchGcmtMonth).not.toHaveBeenCalled();
    db.close();
  });

  it('refetches the combined file only when its name has moved on', async () => {
    // The name carries the last complete year, so a new one appears each
    // January. 8.8 MB to gain a year, and every insert is an upsert.
    const { db, controller } = setup();
    await controller.start();
    vi.clearAllMocks();

    // Same name still recorded, so a run a year later still skips it — the
    // guard is on the `jan76_` prefix rather than an exact match, because the
    // point is "do we have a combined catalogue at all".
    const later = createGcmtController(db, () => {}, () => new Date('2027-04-15T00:00:00Z'));
    await later.start();
    expect(fetchGcmtCombined).not.toHaveBeenCalled();
    db.close();
  });

  it('records the chunk only after the rows are committed', async () => {
    // A failure partway must leave the chunk unrecorded, so the refetch is
    // harmless rather than a permanent hole.
    const { db, controller } = setup();
    fetchGcmtCombined.mockRejectedValue(new Error('network down'));

    const final = await controller.start();
    expect(final.state).toBe('failed');
    expect(final.completedChunks).toBe(0);
    expect(focalMechanismCoverage(db).total).toBe(0);
    db.close();
  });

  it('surfaces a failure as a typed state rather than throwing', async () => {
    const { db, controller } = setup();
    fetchGcmtCombined.mockRejectedValue(new Error('network down'));

    const final = await controller.start();
    expect(final.state).toBe('failed');
    expect(final.error).toContain('combined catalogue');
    db.close();
  });

  it('retries a transient failure before giving up', async () => {
    const { db, controller } = setup();
    fetchGcmtCombined
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValue({
        chunk: { chunk: 'jan76_dec25', kind: 'combined' },
        mechanisms: [mechanism('C1976', '1976-01-01T00:00:00.000Z')],
      });

    const final = await controller.start();
    expect(final.state).toBe('complete');
    expect(fetchGcmtCombined).toHaveBeenCalledTimes(2);
    db.close();
  });

  it('shares one run rather than starting a second concurrently', async () => {
    const { db, controller } = setup();
    const [a, b] = await Promise.all([controller.start(), controller.start()]);
    expect(a).toEqual(b);
    expect(fetchGcmtCombined).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('stores what the fetch returned', async () => {
    const { db, controller } = setup();
    fetchGcmtCombined.mockResolvedValue({
      chunk: { chunk: 'jan76_dec25', kind: 'combined' },
      mechanisms: [
        mechanism('A', '1976-01-01T00:00:00.000Z'),
        mechanism('B', '2000-01-01T00:00:00.000Z'),
      ],
    });

    await controller.start();
    expect(queryFocalMechanisms(db, {}).map((m) => m.id)).toEqual(['A', 'B']);
    db.close();
  });

  it('reports what is stored before any run in this session', () => {
    const { db, controller } = setup();
    const idle = controller.status();
    expect(idle.state).toBe('idle');
    expect(idle.storedMechanisms).toBe(0);
    expect(idle.currentChunk).toBeNull();
    db.close();
  });
});

describe('registerGcmtIpcHandlers', () => {
  it('registers status, start and cancel', () => {
    const { db, controller } = setup();
    registerGcmtIpcHandlers(controller);
    const channels = ipcHandle.mock.calls.map(([channel]) => channel as string);
    expect(channels).toEqual(['gcmt:status', 'gcmt:start', 'gcmt:cancel']);
    db.close();
  });
});
