import { describe, expect, it } from 'vitest';
import { parseDisturbance, parseStations } from './usgs-magnetometer';

/** The service's real shape, trimmed. */
const observatories = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'BOU',
      properties: { name: 'Boulder', agency: 'USGS' },
      geometry: { type: 'Point', coordinates: [254.763, 40.137, 1682] },
    },
    {
      type: 'Feature',
      id: 'BDT',
      properties: { name: 'Boulder Test', agency: 'USGS' },
      geometry: { type: 'Point', coordinates: [254.763, 40.137, 1682] },
    },
    {
      type: 'Feature',
      id: 'KAK',
      properties: { name: 'Kakioka', agency: 'JMA' },
      geometry: { type: 'Point', coordinates: [140.18, 36.23, 36] },
    },
    {
      type: 'Feature',
      id: 'NUL',
      properties: { name: 'No Geometry' },
      geometry: null,
    },
  ],
};

describe('parseStations', () => {
  it('reads code, name and position', () => {
    const stations = parseStations(observatories);
    const kakioka = stations.find((s) => s.code === 'KAK');
    expect(kakioka?.name).toBe('Kakioka');
    expect(kakioka?.latitude).toBeCloseTo(36.23, 2);
    expect(kakioka?.longitude).toBeCloseTo(140.18, 2);
    expect(kakioka?.agency).toBe('JMA');
  });

  it('converts longitude from 0-360 to signed degrees', () => {
    // Boulder arrives as 254.8 and belongs at -105.2. Left alone it lands in
    // the Pacific, which looks plausible enough on a globe to go unnoticed.
    expect(parseStations(observatories).find((s) => s.code === 'BOU')?.longitude).toBeCloseTo(
      -105.237,
      3,
    );
  });

  it('drops test rigs, which share real stations coordinates exactly', () => {
    // BDT sits on BOU's exact position and reports a different disturbance.
    // Drawn, it stacks invisibly on a real station — worse than being absent.
    const codes = parseStations(observatories).map((s) => s.code);
    expect(codes).toContain('BOU');
    expect(codes).not.toContain('BDT');
  });

  it('drops a station with no position rather than placing it at zero', () => {
    // One listed observatory genuinely has null geometry. (0,0) is in the
    // Atlantic and looks like a real station.
    expect(parseStations(observatories).map((s) => s.code)).not.toContain('NUL');
  });

  it('rejects a payload that is not a feature collection', () => {
    expect(() => parseStations(null)).toThrow();
    expect(() => parseStations({})).toThrow(/features/i);
  });
});

const series = (values: (number | null)[]) => ({
  times: values.map((_, i) => new Date(Date.UTC(2026, 7, 15, 9, i)).toISOString()),
  values: [{ id: 'H', values }],
});

describe('parseDisturbance', () => {
  it('reports the range of the horizontal component', () => {
    // Largest minus smallest — the quantity K-indices are derived from, kept in
    // nT so it stays comparable between stations.
    const result = parseDisturbance('BOU', series([20460, 20465, 20455, 20461]));
    expect(result?.rangeNt).toBeCloseTo(10, 6);
    expect(result?.samples).toBe(4);
    expect(result?.code).toBe('BOU');
  });

  it('ignores dropouts rather than reading them as zero', () => {
    // A null treated as a value would produce a 20,000 nT range — a fictional
    // superstorm at any station with a telemetry gap.
    const result = parseDisturbance('BOU', series([20460, null, 20465, null]));
    expect(result?.rangeNt).toBeCloseTo(5, 6);
    expect(result?.samples).toBe(2);
  });

  it('returns null when a single reading survives', () => {
    // One sample has no range. Reporting 0 would be indistinguishable from a
    // perfectly steady hour, which one reading cannot establish.
    expect(parseDisturbance('BOU', series([20460]))).toBeNull();
    expect(parseDisturbance('BOU', series([null, null]))).toBeNull();
  });

  it('returns null for a malformed or empty payload rather than throwing', () => {
    // Stations drop out constantly; an outage must not fail the whole refresh.
    expect(parseDisturbance('BOU', null)).toBeNull();
    expect(parseDisturbance('BOU', {})).toBeNull();
    expect(parseDisturbance('BOU', { times: [], values: [] })).toBeNull();
  });

  it('carries the last observation time, so staleness is visible', () => {
    const result = parseDisturbance('BOU', series([1, 2, 3]));
    expect(result?.observedAtUtc).toBe('2026-08-15T09:02:00.000Z');
  });
});
