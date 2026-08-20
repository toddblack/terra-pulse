import { describe, expect, it } from 'vitest';
import type { CmeArrival, SolarFlare } from '@terra-pulse/schema';
import { openDatabase } from './client';
import {
  completedDonkiYears,
  donkiChunkSummary,
  insertCmeArrivals,
  insertSolarFlares,
  queryCmeArrivals,
  querySolarFlares,
  recordDonkiChunk,
  recordGoesFlareChunk,
  completedGoesFlareYears,
  goesFlareChunkSummary,
} from './solar-events-queries';

const flare = (overrides: Partial<SolarFlare> = {}): SolarFlare => ({
  id: '2026-08-10T12:34:00-FLR-001',
  // These fixtures are DONKI-shaped, matching the id above. The GOES cases
  // below override it explicitly.
  source: 'donki',
  classType: 'M2.4',
  flareClass: 'M',
  magnitude: 2.4,
  peakTimeUtc: '2026-08-10T13:16:00.000Z',
  beginTimeUtc: '2026-08-10T12:34:00.000Z',
  endTimeUtc: '2026-08-10T13:38:00.000Z',
  sourceLocation: 'N14W102',
  activeRegionNumber: 13842,
  link: 'https://example.test/flr',
  ...overrides,
});

const arrival = (overrides: Partial<CmeArrival> = {}): CmeArrival => ({
  simulationId: 'WSA-ENLIL/1234',
  arrivalTimeUtc: '2026-07-05T12:00:00.000Z',
  predictedKp: 5,
  glancingBlow: false,
  minorImpact: false,
  link: 'https://example.test/enlil',
  ...overrides,
});

const fresh = () => openDatabase(':memory:');

describe('insertSolarFlares', () => {
  it('stores and reads back a batch', () => {
    const db = fresh();
    insertSolarFlares(db, [flare(), flare({ id: 'b', peakTimeUtc: '2026-08-11T00:00:00.000Z' })]);

    const rows = querySolarFlares(db, '2026-08-10T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.magnitude).toBe(2.4);
  });

  it('overwrites on a re-fetch of the same id, rather than duplicating', () => {
    // DONKI revises records in place under a stable id — see nasa-donki.ts's
    // note on why no dedupe pass is needed. A second fetch of the same id is a
    // revision, not a second observation.
    const db = fresh();
    insertSolarFlares(db, [flare({ classType: 'M2.4', magnitude: 2.4 })]);
    insertSolarFlares(db, [flare({ classType: 'M3.1', magnitude: 3.1 })]);

    const rows = querySolarFlares(db, '2026-08-10T00:00:00.000Z', '2026-08-11T00:00:00.000Z');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.magnitude).toBe(3.1);
  });

  it('does nothing for an empty batch', () => {
    expect(insertSolarFlares(fresh(), [])).toBe(0);
  });

  it('keeps nullable fields null rather than coercing', () => {
    const db = fresh();
    insertSolarFlares(db, [
      flare({ beginTimeUtc: null, endTimeUtc: null, sourceLocation: null, activeRegionNumber: null }),
    ]);
    const [row] = querySolarFlares(db, '2026-08-10T00:00:00.000Z', '2026-08-11T00:00:00.000Z');
    expect(row?.beginTimeUtc).toBeNull();
    expect(row?.activeRegionNumber).toBeNull();
  });
});

describe('querySolarFlares', () => {
  it('is bounded at both ends and half-open at the top', () => {
    const db = fresh();
    insertSolarFlares(db, [
      flare({ id: 'a', peakTimeUtc: '2026-08-10T00:00:00.000Z' }),
      flare({ id: 'b', peakTimeUtc: '2026-08-11T00:00:00.000Z' }),
      flare({ id: 'c', peakTimeUtc: '2026-08-12T00:00:00.000Z' }),
    ]);

    const rows = querySolarFlares(db, '2026-08-10T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('returns flares peak-time-ordered, not insertion-ordered', () => {
    const db = fresh();
    insertSolarFlares(db, [
      flare({ id: 'b', peakTimeUtc: '2026-08-11T00:00:00.000Z' }),
      flare({ id: 'a', peakTimeUtc: '2026-08-10T00:00:00.000Z' }),
    ]);
    const rows = querySolarFlares(db, '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('insertCmeArrivals / queryCmeArrivals', () => {
  it('stores, reads back, and round-trips the boolean flags through SQLite integers', () => {
    const db = fresh();
    insertCmeArrivals(db, [arrival({ glancingBlow: true, minorImpact: false })]);

    const [row] = queryCmeArrivals(db, '2026-07-05T00:00:00.000Z', '2026-07-06T00:00:00.000Z');
    expect(row?.glancingBlow).toBe(true);
    expect(row?.minorImpact).toBe(false);
  });

  it('overwrites on a re-fetch of the same simulation id', () => {
    const db = fresh();
    insertCmeArrivals(db, [arrival({ predictedKp: 5 })]);
    insertCmeArrivals(db, [arrival({ predictedKp: 7 })]);

    const rows = queryCmeArrivals(db, '2026-07-05T00:00:00.000Z', '2026-07-06T00:00:00.000Z');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.predictedKp).toBe(7);
  });

  it('keeps a null predicted Kp null, not zero', () => {
    // Zero Kp is a real quiet reading; "the model produced none" is not.
    const db = fresh();
    insertCmeArrivals(db, [arrival({ predictedKp: null })]);
    const [row] = queryCmeArrivals(db, '2026-07-05T00:00:00.000Z', '2026-07-06T00:00:00.000Z');
    expect(row?.predictedKp).toBeNull();
  });

  it('does nothing for an empty batch', () => {
    expect(insertCmeArrivals(fresh(), [])).toBe(0);
  });
});

describe('donki chunk bookkeeping', () => {
  it('tracks completed years per source independently', () => {
    const db = fresh();
    recordDonkiChunk(db, 2015, 'flares', 127);
    expect(completedDonkiYears(db, 'flares')).toEqual(new Set([2015]));
    // The whole reason this table has a `source` column: recording a flares
    // year must not make a CME backfill think that year is done too.
    expect(completedDonkiYears(db, 'cme')).toEqual(new Set());
  });

  it('is idempotent on (year, source), so a re-run updates rather than duplicates', () => {
    const db = fresh();
    recordDonkiChunk(db, 2015, 'flares', 127);
    recordDonkiChunk(db, 2015, 'flares', 130);

    expect(completedDonkiYears(db, 'flares')).toEqual(new Set([2015]));
    expect(donkiChunkSummary(db, 'flares')).toEqual({ completedChunks: 1, storedEvents: 130 });
  });

  it('summarises chunks and stored counts per source', () => {
    const db = fresh();
    recordDonkiChunk(db, 2014, 'flares', 215);
    recordDonkiChunk(db, 2015, 'flares', 127);
    recordDonkiChunk(db, 2014, 'cme', 30);

    expect(donkiChunkSummary(db, 'flares')).toEqual({ completedChunks: 2, storedEvents: 342 });
    expect(donkiChunkSummary(db, 'cme')).toEqual({ completedChunks: 1, storedEvents: 30 });
  });

  it('reports an empty table honestly', () => {
    const db = fresh();
    expect(completedDonkiYears(db, 'flares')).toEqual(new Set());
    expect(donkiChunkSummary(db, 'flares')).toEqual({ completedChunks: 0, storedEvents: 0 });
  });
});

describe('querySolarFlares source precedence', () => {
  /** The same flare, as each catalogue records it — an overlap-year event. */
  const overlapPair = (peakTimeUtc: string) => [
    flare({ id: `donki:${peakTimeUtc}`, source: 'donki', peakTimeUtc }),
    flare({ id: `goes:${peakTimeUtc}`, source: 'goes', peakTimeUtc }),
  ];

  it('returns each overlap-year flare once, from GOES', () => {
    // Both catalogues cover 2014-2016. Returning both would double-count the
    // flare in H1b's trigger set and draw it twice on the globe.
    const db = fresh();
    insertSolarFlares(db, overlapPair('2015-06-01T00:00:00.000Z'));

    const rows = querySolarFlares(db, '2015-01-01', '2016-01-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('goes');
  });

  it('reads DONKI above the boundary and GOES at or below it', () => {
    const db = fresh();
    insertSolarFlares(db, [
      ...overlapPair('2016-12-31T00:00:00.000Z'),
      ...overlapPair('2017-01-01T00:00:00.000Z'),
    ]);

    const rows = querySolarFlares(db, '2016-01-01', '2018-01-01');
    expect(rows.map((r) => [r.peakTimeUtc.slice(0, 4), r.source])).toEqual([
      ['2016', 'goes'],
      ['2017', 'donki'],
    ]);
  });

  it('hides a DONKI row below the boundary that GOES does not also have', () => {
    // DONKI's own record starts in 2010 and is 23-25% complete for 2011-13, so
    // reading it below 2017 would mix a sparse catalogue into a complete one.
    const db = fresh();
    insertSolarFlares(db, [
      flare({ id: 'donki:2012', source: 'donki', peakTimeUtc: '2012-05-01T00:00:00.000Z' }),
    ]);

    expect(querySolarFlares(db, '2012-01-01', '2013-01-01')).toEqual([]);
  });

  it('returns both catalogues on request, which is what checking the join needs', () => {
    const db = fresh();
    insertSolarFlares(db, overlapPair('2015-06-01T00:00:00.000Z'));

    expect(querySolarFlares(db, '2015-01-01', '2016-01-01', { source: 'all' })).toHaveLength(2);
    expect(querySolarFlares(db, '2015-01-01', '2016-01-01', { source: 'goes' })).toHaveLength(1);
    expect(querySolarFlares(db, '2015-01-01', '2016-01-01', { source: 'donki' })).toHaveLength(1);
  });

  it('defaults every existing row to donki, so the migration needs no backfill', () => {
    const db = fresh();
    db.exec(`INSERT INTO solar_flares (id, class_type, flare_class, magnitude, peak_time_utc)
             VALUES ('legacy', 'M1.0', 'M', 1.0, '2020-01-01T00:00:00.000Z')`);

    expect(querySolarFlares(db, '2020-01-01', '2021-01-01')[0]?.source).toBe('donki');
  });
});

describe('goes flare chunks', () => {
  it('records, reports and stays idempotent per year', () => {
    const db = fresh();
    recordGoesFlareChunk(db, 2015, 1962);
    recordGoesFlareChunk(db, 2015, 1963);
    recordGoesFlareChunk(db, 2016, 1194);

    expect(completedGoesFlareYears(db)).toEqual(new Set([2015, 2016]));
    expect(goesFlareChunkSummary(db)).toEqual({ completedChunks: 2, storedEvents: 3157 });
  });

  it('records a genuinely empty year, which row presence could not', () => {
    // 2009 really has zero M/X flares — without this the year would be
    // refetched on every run forever.
    const db = fresh();
    recordGoesFlareChunk(db, 2009, 0);

    expect(completedGoesFlareYears(db)).toEqual(new Set([2009]));
    expect(goesFlareChunkSummary(db)).toEqual({ completedChunks: 1, storedEvents: 0 });
  });

  it('reports an empty table honestly', () => {
    const db = fresh();
    expect(completedGoesFlareYears(db)).toEqual(new Set());
    expect(goesFlareChunkSummary(db)).toEqual({ completedChunks: 0, storedEvents: 0 });
  });
});
