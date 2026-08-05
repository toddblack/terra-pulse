import { describe, expect, it } from 'vitest';
import type { EarthquakeEvent } from '@terra-pulse/schema';
import { gardnerKnopoffRadiusKm, gardnerKnopoffWindowDays } from '@terra-pulse/schema';
import { openDatabase } from './client';
import { insertEarthquakes } from './queries';
import { recordArchiveChunk } from './archive-queries';
import { queryAftershockSequence } from './aftershock-queries';

const MAINSHOCK_TIME = '2020-06-15T00:00:00.000Z';
const ORIGIN_MS = Date.parse(MAINSHOCK_TIME);
const DAY_MS = 86_400_000;

function makeEvent(overrides: Partial<EarthquakeEvent> & { id: string }): EarthquakeEvent {
  return {
    source: 'usgs',
    magnitude: 5,
    magnitudeType: 'mww',
    place: 'somewhere',
    timeUtc: MAINSHOCK_TIME,
    updatedUtc: MAINSHOCK_TIME,
    longitude: 140,
    latitude: 38,
    depthKm: 20,
    status: 'reviewed',
    tsunami: false,
    alertLevel: null,
    significance: null,
    url: 'https://example.test',
    ...overrides,
  };
}

/** A mainshock big enough for a roomy window: M7 is 70.7 km / 918 days. */
const mainshock = makeEvent({ id: 'main', magnitude: 7, latitude: 38, longitude: 140 });

/** Offsets a point north by `km`, staying on the same meridian. */
function north(from: EarthquakeEvent, km: number): { latitude: number; longitude: number } {
  return { latitude: from.latitude + km / 111.32, longitude: from.longitude };
}

/** Marks the whole archive downloaded, so coverage never confuses these tests. */
function withFullArchive(db: ReturnType<typeof openDatabase>, from = 1970, to = 2026) {
  for (let year = from; year <= to; year += 1) {
    recordArchiveChunk(
      db,
      {
        year,
        startUtc: `${year}-01-01T00:00:00.000Z`,
        endUtc: `${year + 1}-01-01T00:00:00.000Z`,
      },
      4.5,
      0,
    );
  }
}

/** `now` well past the M7 window, so every sequence below is settled. */
const AFTER_WINDOW_MS = ORIGIN_MS + 1200 * DAY_MS;

describe('queryAftershockSequence', () => {
  it('counts events inside the Gardner-Knopoff window', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, [
      mainshock,
      makeEvent({
        id: 'near',
        magnitude: 5.4,
        timeUtc: new Date(ORIGIN_MS + 2 * DAY_MS).toISOString(),
        ...north(mainshock, 20),
      }),
      makeEvent({
        id: 'also-near',
        magnitude: 4.9,
        timeUtc: new Date(ORIGIN_MS + 40 * DAY_MS).toISOString(),
        ...north(mainshock, 60),
      }),
    ]);

    const { summary } = queryAftershockSequence(db, mainshock, AFTER_WINDOW_MS);
    expect(summary.count).toBe(2);
    expect(summary.largest?.id).toBe('near');
  });

  it('never counts the mainshock as its own aftershock', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, [mainshock]);

    const { summary } = queryAftershockSequence(db, mainshock, AFTER_WINDOW_MS);
    expect(summary.count).toBe(0);
    expect(summary.largest).toBeNull();
  });

  it('counts a genuinely simultaneous event elsewhere in the window', () => {
    // The mainshock is excluded by id, not by a strict time bound, so an event
    // sharing its timestamp is still a real second event.
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, [
      mainshock,
      makeEvent({ id: 'twin', magnitude: 5.1, timeUtc: MAINSHOCK_TIME, ...north(mainshock, 30) }),
    ]);

    expect(queryAftershockSequence(db, mainshock, AFTER_WINDOW_MS).summary.count).toBe(1);
  });

  it('excludes events before the mainshock', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, [
      mainshock,
      makeEvent({
        id: 'foreshock',
        magnitude: 5.5,
        timeUtc: new Date(ORIGIN_MS - DAY_MS).toISOString(),
        ...north(mainshock, 10),
      }),
    ]);

    expect(queryAftershockSequence(db, mainshock, AFTER_WINDOW_MS).summary.count).toBe(0);
  });

  it('excludes events past the end of the time window', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    const beyondDays = gardnerKnopoffWindowDays(7) + 10;
    insertEarthquakes(db, [
      mainshock,
      makeEvent({
        id: 'too-late',
        magnitude: 5.5,
        timeUtc: new Date(ORIGIN_MS + beyondDays * DAY_MS).toISOString(),
        ...north(mainshock, 10),
      }),
    ]);

    expect(queryAftershockSequence(db, mainshock, AFTER_WINDOW_MS).summary.count).toBe(0);
  });

  /**
   * The R-Tree answers in rectangles. Without the haversine step the corner of
   * the box — 1.41× the radius — would count, inflating every large sequence.
   */
  it('excludes events in the bounding box but outside the radius', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    const radiusKm = gardnerKnopoffRadiusKm(7);
    const cornerDeg = (radiusKm * 0.95) / 111.32;
    insertEarthquakes(db, [
      mainshock,
      // Inside the box on both axes, but ~1.34× the radius away diagonally.
      makeEvent({
        id: 'corner',
        magnitude: 5.5,
        timeUtc: new Date(ORIGIN_MS + DAY_MS).toISOString(),
        latitude: mainshock.latitude + cornerDeg,
        longitude:
          mainshock.longitude +
          (radiusKm * 0.95) / (111.32 * Math.cos((mainshock.latitude * Math.PI) / 180)),
      }),
    ]);

    expect(queryAftershockSequence(db, mainshock, AFTER_WINDOW_MS).summary.count).toBe(0);
  });

  it('excludes events below the sequence floor', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, [
      mainshock,
      makeEvent({
        id: 'small',
        magnitude: 4.4,
        timeUtc: new Date(ORIGIN_MS + DAY_MS).toISOString(),
        ...north(mainshock, 10),
      }),
    ]);

    expect(queryAftershockSequence(db, mainshock, AFTER_WINDOW_MS).summary.count).toBe(0);
  });

  /**
   * The bug `sequenceSearchBoxes` exists to prevent, exercised end to end
   * against a real R-Tree: a naive box around 179°E runs 177→182 and matches
   * nothing, so a Kuril mainshock would report a confident zero.
   */
  it('finds aftershocks across the antimeridian', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    const kuril = makeEvent({ id: 'kuril', magnitude: 7, latitude: 50, longitude: 179.5 });
    insertEarthquakes(db, [
      kuril,
      makeEvent({
        id: 'across',
        magnitude: 5.6,
        timeUtc: new Date(ORIGIN_MS + DAY_MS).toISOString(),
        latitude: 50,
        // ~36 km east of the mainshock, on the other side of the date line.
        longitude: -180 + 0.0,
      }),
    ]);

    const { summary } = queryAftershockSequence(db, kuril, AFTER_WINDOW_MS);
    expect(summary.count).toBe(1);
    expect(summary.largest?.id).toBe('across');
  });

  it('clamps the query to now for a sequence still running', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, [mainshock]);

    const tenDaysIn = ORIGIN_MS + 10 * DAY_MS;
    const { summary } = queryAftershockSequence(db, mainshock, tenDaysIn);
    expect(summary.elapsedFraction).toBeLessThan(0.02);
    expect(summary.elapsedFraction).toBeGreaterThan(0);
  });

  it('returns an empty sequence for a mainshock in the future', () => {
    // Reachable by scrubbing the playhead back before the selected event.
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, [mainshock]);

    const { summary } = queryAftershockSequence(db, mainshock, ORIGIN_MS - DAY_MS);
    expect(summary.count).toBe(0);
    expect(summary.elapsedFraction).toBe(0);
  });
});

/**
 * The distinction that keeps a zero honest. "No aftershocks were recorded" and
 * "the archive for those years was never downloaded" produce the same count,
 * and the panel has to be able to tell them apart.
 */
describe('archive coverage reporting', () => {
  it('reports no gaps when the archive covers the window', () => {
    const db = openDatabase(':memory:');
    withFullArchive(db);
    insertEarthquakes(db, [mainshock]);

    expect(queryAftershockSequence(db, mainshock, AFTER_WINDOW_MS).missingYears).toEqual([]);
  });

  it('reports every uncovered year the elapsed window touches', () => {
    const db = openDatabase(':memory:');
    // 2020 downloaded, 2021 and 2022 not — the M7 window runs 918 days from
    // mid-2020, so it reaches into 2022.
    withFullArchive(db, 2020, 2020);
    insertEarthquakes(db, [mainshock]);

    const { missingYears } = queryAftershockSequence(db, mainshock, AFTER_WINDOW_MS);
    expect(missingYears).toEqual([2021, 2022]);
  });

  it('never reports a gap for years the window has not reached yet', () => {
    // The M7 window ends in 2022, but only ten days have passed. 2021 and 2022
    // are not missing data; they have not happened.
    const db = openDatabase(':memory:');
    withFullArchive(db, 2020, 2020);
    insertEarthquakes(db, [mainshock]);

    const { missingYears } = queryAftershockSequence(db, mainshock, ORIGIN_MS + 10 * DAY_MS);
    expect(missingYears).toEqual([]);
  });

  it('treats a window inside the rolling cache as covered with no archive', () => {
    // Someone who has never downloaded the archive still gets a correct
    // sequence for last week's earthquake — the rolling cache runs below M4.5.
    const db = openDatabase(':memory:');
    const nowMs = Date.parse('2026-08-05T00:00:00.000Z');
    const recent = makeEvent({
      id: 'recent',
      magnitude: 7,
      timeUtc: new Date(nowMs - 3 * DAY_MS).toISOString(),
    });
    insertEarthquakes(db, [recent]);

    expect(queryAftershockSequence(db, recent, nowMs).missingYears).toEqual([]);
  });

  it('treats the current year as covered once the archive exists', () => {
    // The archive refetches the current year every run but can never record it
    // complete, so coverage has to infer it rather than read it.
    const db = openDatabase(':memory:');
    const nowMs = Date.parse('2026-08-05T00:00:00.000Z');
    withFullArchive(db, 1970, 2025);
    const thisYear = makeEvent({
      id: 'this-year',
      magnitude: 7,
      timeUtc: '2026-02-01T00:00:00.000Z',
    });
    insertEarthquakes(db, [thisYear]);

    expect(queryAftershockSequence(db, thisYear, nowMs).missingYears).toEqual([]);
  });

  it('reports a historical window as uncovered when the archive is absent', () => {
    const db = openDatabase(':memory:');
    insertEarthquakes(db, [mainshock]);

    const { missingYears } = queryAftershockSequence(db, mainshock, AFTER_WINDOW_MS);
    expect(missingYears).toEqual([2020, 2021, 2022]);
  });
});
