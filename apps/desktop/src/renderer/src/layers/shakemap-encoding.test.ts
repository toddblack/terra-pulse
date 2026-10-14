import { describe, expect, it } from 'vitest';
import type { IntensityContour, ShakeMapContours } from '@terra-pulse/schema';
import {
  MIN_INTENSITY_DRAWN,
  MIN_LINE_POINTS,
  intensityColor,
  intensityNumeral,
  intensityWord,
  isoseismalReachKm,
  isoseismalsToDraw,
  labelPoint,
  shakeMapSummary,
} from './shakemap-encoding';

/** A line of `points` vertices running east from a start, 0.01° apart. */
function line(points: number, longitude = -118, latitude = 35): [number, number][] {
  return Array.from({ length: points }, (_, index) => [longitude + index * 0.01, latitude]);
}

function level(mmi: number, ...lengths: number[]): IntensityContour {
  return { mmi, lines: lengths.map((length) => line(length)) };
}

describe('isoseismalsToDraw', () => {
  it('draws the half-step lines, named for the zone each encloses', () => {
    // A place rounds to V between 4.5 and 5.5, so the 4.5 line is the edge of
    // V. The whole-number lines run through the middle of a zone.
    const drawn = isoseismalsToDraw([level(4, 50), level(4.5, 50), level(5, 50), level(5.5, 50)]);
    expect(drawn.map((isoseismal) => isoseismal.intensity)).toEqual([5, 6]);
  });

  it('leaves out everything weaker than III', () => {
    const drawn = isoseismalsToDraw([level(1.5, 50), level(2.5, 50), level(3.5, 50)]);
    expect(drawn.map((isoseismal) => isoseismal.intensity)).toEqual([3, 4]);
    expect(drawn[0]?.intensity).toBe(MIN_INTENSITY_DRAWN);
  });

  it('drops the specks and keeps the outlines', () => {
    // Ridgecrest's IV edge: one loop of 385 points and dozens of islands a
    // few cells across.
    const drawn = isoseismalsToDraw([level(3.5, 385, 30, 8, 5, 4), level(4.5, 100)]);
    const zoneFour = drawn.find((isoseismal) => isoseismal.intensity === 4);
    expect(zoneFour?.lines.map((piece) => piece.length)).toEqual([385, 30]);
  });

  it('keeps the innermost line even when it is short', () => {
    // Panama 2026: the edge of VIII is a single piece of 9 points. It is small
    // because the zone is, and it is the peak of the map.
    const drawn = isoseismalsToDraw([level(5.5, 100), level(6.5, 31), level(7.5, 9)]);
    const strongest = drawn[drawn.length - 1];
    expect(strongest?.intensity).toBe(8);
    expect(strongest?.lines.map((piece) => piece.length)).toEqual([9]);
  });

  it('keeps only the longest piece of an innermost level that is all specks', () => {
    const drawn = isoseismalsToDraw([level(5.5, 100), level(6.5, 6, 9, 4)]);
    expect(drawn[drawn.length - 1]?.lines.map((piece) => piece.length)).toEqual([9]);
  });

  it('drops an outer level that is nothing but specks', () => {
    // Michoacán 1985's III edge: five fragments, the longest 9 points, where
    // the level runs off the edge of the map.
    const drawn = isoseismalsToDraw([level(2.5, 9, 7, 6, 5, 4), level(3.5, 219), level(4.5, 197)]);
    expect(drawn.map((isoseismal) => isoseismal.intensity)).toEqual([4, 5]);
  });

  it('falls back to whole-number lines when a map has no half steps', () => {
    const drawn = isoseismalsToDraw([level(3, 50), level(4, 50), level(5, 50)]);
    expect(drawn.map((isoseismal) => isoseismal.intensity)).toEqual([3, 4, 5]);
  });

  it('comes back weakest first whatever order the levels arrive in', () => {
    const drawn = isoseismalsToDraw([level(6.5, 50), level(3.5, 50), level(5.5, 50)]);
    expect(drawn.map((isoseismal) => isoseismal.intensity)).toEqual([4, 6, 7]);
  });

  it('is empty for a map with nothing drawable', () => {
    expect(isoseismalsToDraw([])).toEqual([]);
    expect(isoseismalsToDraw([level(1.5, 50)])).toEqual([]);
  });

  it('uses a threshold that a main outline clears by a wide margin', () => {
    // The shortest innermost lines measured were 17 points, the shortest main
    // loops of outer levels over 100. If this ever needs raising toward those,
    // re-measure rather than guess.
    expect(MIN_LINE_POINTS).toBeLessThan(17);
  });
});

describe('the intensity scale', () => {
  it('writes intensity in Roman numerals', () => {
    expect(intensityNumeral(3)).toBe('III');
    expect(intensityNumeral(4)).toBe('IV');
    expect(intensityNumeral(9)).toBe('IX');
    expect(intensityNumeral(10)).toBe('X');
  });

  it('rounds a measured value to its class, as intensity is reported', () => {
    expect(intensityNumeral(7.707)).toBe('VIII');
    expect(intensityNumeral(7.4)).toBe('VII');
    expect(intensityNumeral(9.537)).toBe('X');
  });

  it('never runs off either end of the scale', () => {
    expect(intensityNumeral(0)).toBe('I');
    expect(intensityNumeral(12)).toBe('X');
  });

  it('uses USGS words for each class', () => {
    expect(intensityWord(3)).toBe('weak');
    expect(intensityWord(4)).toBe('light');
    expect(intensityWord(5)).toBe('moderate');
    expect(intensityWord(6)).toBe('strong');
    expect(intensityWord(7)).toBe('very strong');
    expect(intensityWord(8)).toBe('severe');
    expect(intensityWord(9)).toBe('violent');
    expect(intensityWord(10)).toBe('extreme');
  });

  it('has a distinct colour for every class it can draw', () => {
    const colours = [3, 4, 5, 6, 7, 8, 9, 10].map(intensityColor);
    expect(new Set(colours).size).toBe(colours.length);
    for (const colour of colours) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('matches the colours read out of real USGS contour files', () => {
    // Pinned so a tidy-up cannot nudge them: the point of using this scale is
    // that it is the one on every ShakeMap a reader has already seen.
    expect(intensityColor(4)).toBe('#80ffff');
    expect(intensityColor(6)).toBe('#ffff00');
    expect(intensityColor(8)).toBe('#ff9100');
    expect(intensityColor(9)).toBe('#fd0000');
  });
});

describe('labelPoint', () => {
  it('sits on the northernmost point of the longest piece', () => {
    const main: [number, number][] = [
      [-118, 35],
      [-117.5, 36.2],
      [-117, 35.5],
    ];
    const island: [number, number][] = [
      [-116, 39],
      [-115.9, 39.1],
    ];
    // The island is further north, but it is not the zone's edge.
    expect(labelPoint({ intensity: 5, lines: [island, main] })).toEqual([-117.5, 36.2]);
  });

  it('is null when there is nothing to label', () => {
    expect(labelPoint({ intensity: 5, lines: [] })).toBeNull();
  });
});

describe('isoseismalReachKm', () => {
  it('is the furthest any drawn line gets from the epicentre', () => {
    const epicentre = { latitude: 35, longitude: -118 };
    // One degree of latitude is about 111 km.
    const reach = isoseismalReachKm(
      [
        { intensity: 5, lines: [[[-118, 35.2], [-118, 36]]] },
        { intensity: 6, lines: [[[-118, 35.1], [-118, 35.3]]] },
      ],
      epicentre,
    );
    expect(reach).toBeGreaterThan(108);
    expect(reach).toBeLessThan(114);
  });

  it('is zero with nothing drawn', () => {
    expect(isoseismalReachKm([], { latitude: 0, longitude: 0 })).toBe(0);
  });
});

describe('shakeMapSummary', () => {
  const map: ShakeMapContours = {
    eventId: 'us6000u18k',
    maxMmi: 7.707,
    source: 'us',
    version: '10',
    processedAtUtc: null,
    contours: [],
  };

  it('names the peak in the numeral the lines carry, and whose estimate it is', () => {
    expect(shakeMapSummary(map)).toBe('peak VIII (severe) · USGS ShakeMap');
  });

  it('says when the map is the Atlas reprocessing of a past quake', () => {
    expect(shakeMapSummary({ ...map, source: 'atlas' })).toContain('ShakeMap Atlas');
  });

  it('leaves the peak out when USGS did not state one', () => {
    expect(shakeMapSummary({ ...map, maxMmi: null })).toBe('USGS ShakeMap');
  });
});
