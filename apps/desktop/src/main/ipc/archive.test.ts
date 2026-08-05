import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveChunk, ArchiveProgress, EarthquakeEvent } from '@terra-pulse/schema';
import { openDatabase, listArchiveChunks, queryEarthquakes } from '@terra-pulse/db';
import { ArchiveCancelledError } from '@terra-pulse/ingest';
import { createArchiveController } from './archive';

// `registerArchiveIpcHandlers` imports ipcMain at module load; the controller
// itself never touches Electron.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

const fetchArchiveChunk = vi.hoisted(() => vi.fn());
vi.mock('@terra-pulse/ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@terra-pulse/ingest')>();
  return { ...actual, fetchArchiveChunk };
});

function makeEvent(id: string, year: number): EarthquakeEvent {
  return {
    id,
    source: 'usgs',
    magnitude: 6.1,
    magnitudeType: 'mww',
    place: 'Somewhere',
    timeUtc: `${String(year)}-06-01T00:00:00.000Z`,
    updatedUtc: `${String(year)}-06-01T00:00:00.000Z`,
    longitude: 0,
    latitude: 0,
    depthKm: 10,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: 600,
    url: 'https://example.test',
  };
}

/** Frozen so the chunk plan is a fixed, small set of years. */
const NOW = new Date('1974-05-05T00:00:00.000Z');
const now = () => NOW;

function setup() {
  const db = openDatabase(':memory:');
  const progress: ArchiveProgress[] = [];
  const controller = createArchiveController(db, (p) => progress.push(p), now);
  return { db, controller, progress };
}

beforeEach(() => {
  fetchArchiveChunk.mockReset();
  // One event per year by default, named after the year it came from.
  fetchArchiveChunk.mockImplementation(({ chunk }: { chunk: ArchiveChunk }) =>
    Promise.resolve([makeEvent(`e${String(chunk.year)}`, chunk.year)]),
  );
});

describe('archive controller', () => {
  it('fetches every year from 1970 through the current one', async () => {
    const { controller, db } = setup();

    const result = await controller.start();

    expect(fetchArchiveChunk).toHaveBeenCalledTimes(5); // 1970..1974
    expect(result.state).toBe('complete');
    expect(queryEarthquakes(db)).toHaveLength(5);
  });

  it('records completed years but never the current one', async () => {
    // The current year is still accruing events. A row claiming it is complete
    // would freeze the archive at today, permanently.
    const { controller, db } = setup();

    await controller.start();

    expect(listArchiveChunks(db).map((chunk) => chunk.year)).toEqual([1970, 1971, 1972, 1973]);
  });

  it('resumes rather than restarting, skipping years already recorded', async () => {
    const { controller } = setup();
    await controller.start();
    fetchArchiveChunk.mockClear();

    await controller.start();

    // Only the current year, which is deliberately never final.
    expect(fetchArchiveChunk).toHaveBeenCalledTimes(1);
    const [options] = fetchArchiveChunk.mock.calls[0] as [{ chunk: ArchiveChunk }];
    expect(options.chunk.year).toBe(1974);
  });

  it('retries a failing year before giving up on the run', async () => {
    const { controller } = setup();
    let attempts = 0;
    fetchArchiveChunk.mockImplementation(({ chunk }: { chunk: ArchiveChunk }) => {
      if (chunk.year === 1972) {
        attempts++;
        if (attempts < 3) return Promise.reject(new Error('network blip'));
      }
      return Promise.resolve([makeEvent(`e${String(chunk.year)}`, chunk.year)]);
    });

    const result = await controller.start();

    expect(attempts).toBe(3);
    expect(result.state).toBe('complete');
  });

  it('fails the run when a year keeps failing, and leaves that year unrecorded', async () => {
    const { controller, db } = setup();
    fetchArchiveChunk.mockImplementation(({ chunk }: { chunk: ArchiveChunk }) => {
      if (chunk.year === 1972) return Promise.reject(new Error('gone'));
      return Promise.resolve([makeEvent(`e${String(chunk.year)}`, chunk.year)]);
    });

    const result = await controller.start();

    expect(result.state).toBe('failed');
    expect(result.error).toMatch(/1972/);
    // The years before it stand, so a retry resumes from the break.
    expect(listArchiveChunks(db).map((chunk) => chunk.year)).toEqual([1970, 1971]);
  });

  it('does not record a year whose fetch was cancelled partway', async () => {
    // fetchArchiveChunk throwing on cancel is what protects this; a partial
    // chunk recorded as complete is a permanent silent hole.
    const { controller, db } = setup();
    fetchArchiveChunk.mockImplementation(({ chunk }: { chunk: ArchiveChunk }) => {
      if (chunk.year === 1972) return Promise.reject(new ArchiveCancelledError());
      return Promise.resolve([makeEvent(`e${String(chunk.year)}`, chunk.year)]);
    });

    const result = await controller.start();

    expect(result.state).toBe('cancelled');
    expect(listArchiveChunks(db).map((chunk) => chunk.year)).toEqual([1970, 1971]);
  });

  it('returns the in-flight run instead of starting a second one', async () => {
    // Two concurrent backfills would double every request and race on the
    // bookkeeping rows.
    const { controller } = setup();

    const [a, b] = await Promise.all([controller.start(), controller.start()]);

    expect(fetchArchiveChunk).toHaveBeenCalledTimes(5);
    expect(a).toEqual(b);
  });

  it('can be started again after a failed run', async () => {
    const { controller } = setup();
    fetchArchiveChunk.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    fetchArchiveChunk.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    fetchArchiveChunk.mockImplementationOnce(() => Promise.reject(new Error('boom')));

    expect((await controller.start()).state).toBe('failed');
    expect((await controller.start()).state).toBe('complete');
  });

  it('reports idle with a real total before anything runs', () => {
    const { controller } = setup();

    expect(controller.status()).toEqual({
      state: 'idle',
      completedChunks: 0,
      totalChunks: 5,
      storedEvents: 0,
      currentYear: null,
      error: null,
    });
  });

  it('publishes progress naming the year in flight', async () => {
    const { controller, progress } = setup();

    await controller.start();

    const years = progress.map((p) => p.currentYear).filter((year) => year !== null);
    expect(years).toEqual([1970, 1971, 1972, 1973, 1974]);
    expect(progress.at(-1)?.state).toBe('complete');
    expect(progress.at(-1)?.currentYear).toBeNull();
  });

  it('counts stored events from the bookkeeping, not the live table', async () => {
    // The table also holds rolling-cache rows; the archive's own total has to
    // come from what the archive recorded.
    const { controller } = setup();
    fetchArchiveChunk.mockImplementation(({ chunk }: { chunk: ArchiveChunk }) =>
      Promise.resolve(
        Array.from({ length: 10 }, (_, i) => makeEvent(`e${String(chunk.year)}-${String(i)}`, chunk.year)),
      ),
    );

    const result = await controller.start();

    // Four recorded years at ten events each; 1974 is not recorded.
    expect(result.storedEvents).toBe(40);
  });
});
