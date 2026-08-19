import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceWeatherProgress, SpaceWeatherSample } from '@terra-pulse/schema';

/**
 * The backfill's progress reporting, which shipped broken once.
 *
 * The symptom was "stuck on 0/64 years" while the download ran perfectly: the
 * count was derived from `omniFieldsStale()`, and that marker is only written
 * when the run *finishes*, so it read stale — and therefore zero — for the
 * entire download.
 *
 * Both obvious repairs are also wrong, which is why this is pinned rather than
 * just fixed:
 *
 *   - testing the marker pins the count at 0 for the whole run;
 *   - counting years already present reports ~63 of 64 from the first second,
 *     because a refetch re-reads years that are all in the table already.
 *
 * Only the loop knows how far the loop has got.
 */
const hour = (iso: string, dst: number | null): SpaceWeatherSample => ({
  timeUtc: iso,
  kp: null,
  dst,
  windSpeed: 400,
  density: 5,
  bzGsm: 1,
  xrayFlux: null,
});

vi.mock('@terra-pulse/ingest', () => ({
  fetchGfzKpArchive: vi.fn(async () => Promise.resolve([])),
  fetchGfzKpNowcast: vi.fn(async () => Promise.resolve([])),
  fetchLatestSolarWind: vi.fn(async () => Promise.resolve([])),
  fetchRecentSolarWind: vi.fn(async () => Promise.resolve([])),
  fetchLatestGoesXray: vi.fn(async () => Promise.resolve([])),
  fetchRecentGoesXray: vi.fn(async () => Promise.resolve([])),
  fetchOmniYear: vi.fn(async (year: number) =>
    Promise.resolve([hour(`${String(year)}-06-01T00:00:00.000Z`, -20)]),
  ),
}));

const { openDatabase, insertSpaceWeather, writeAppState } = await import('@terra-pulse/db');
const { createSpaceWeatherController, dstBackfillYears } = await import('./space-weather');

describe('backfill progress', () => {
  let db: ReturnType<typeof openDatabase>;
  let seen: SpaceWeatherProgress[];

  beforeEach(() => {
    db = openDatabase(':memory:');
    seen = [];
  });

  const run = async () => {
    const controller = createSpaceWeatherController(db, (p) => seen.push({ ...p }));
    return controller.start();
  };

  it('advances through a full refetch instead of sitting at zero', async () => {
    const total = dstBackfillYears(new Date().getUTCFullYear()).length;
    await run();

    const running = seen.filter((p) => p.state === 'running').map((p) => p.completedYears);
    // The bug: every one of these was 0, for the entire download.
    expect(Math.max(...running)).toBeGreaterThan(1);
    // Monotonic while running, and reaching every year by the end of the loop —
    // the bar has to actually arrive at full, not stop one short.
    expect([...running].sort((a, b) => a - b)).toEqual(running);
    expect(Math.max(...running)).toBe(total);
    expect(running.at(-1)).toBe(total);
  });

  it('drops back to all-but-the-current-year once idle', async () => {
    // Not an off-by-one. The running count is "years the loop has passed"; the
    // idle count is "years that are *complete*", and the current year never is
    // — it hasn't finished happening. So 64 during the run becomes 63 after it.
    const total = dstBackfillYears(new Date().getUTCFullYear()).length;
    const final = await run();
    expect(final.state).toBe('complete');
    expect(final.completedYears).toBe(total - 1);
  });

  it('counts skipped years, so a short resume does not look like a cold start', async () => {
    // A database that already holds every Dst year *and* the current marker, so
    // the loop skips almost everything.
    const thisYear = new Date().getUTCFullYear();
    for (const year of dstBackfillYears(thisYear)) {
      insertSpaceWeather(db, [hour(`${String(year)}-06-01T00:00:00.000Z`, -20)]);
    }
    writeAppState(db, 'omni_fields', 'dst,wind_speed,density,bz_gsm');

    await run();

    // Skipped years still count as settled — the reader is not waiting for
    // them. Without this a resume of one year would report 1 of 64 and look
    // like it had barely started.
    const running = seen.filter((p) => p.state === 'running').map((p) => p.completedYears);
    expect(Math.max(...running)).toBe(dstBackfillYears(thisYear).length);
  });

  it('reports zero while the parser marker is stale and the run has not started', () => {
    // The idle case the marker exists for: a database with every Dst year but
    // no solar wind must not read as complete, or nobody presses Resume.
    for (const year of dstBackfillYears(new Date().getUTCFullYear())) {
      insertSpaceWeather(db, [hour(`${String(year)}-06-01T00:00:00.000Z`, -20)]);
    }

    const controller = createSpaceWeatherController(db, () => undefined);
    expect(controller.status().completedYears).toBe(0);
  });

  it('writes the marker only after a run that finished', async () => {
    const controller = createSpaceWeatherController(db, () => undefined);
    const before = controller.status().completedYears;
    expect(before).toBe(0);

    await controller.start();
    // Now settled: a second status call goes down the idle path and finds the
    // marker current, so it reports real presence rather than zero.
    expect(controller.status().completedYears).toBeGreaterThan(0);
  });
});
