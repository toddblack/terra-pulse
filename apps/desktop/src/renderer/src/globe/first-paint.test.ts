import { describe, expect, it } from 'vitest';
import { INITIAL_FIRST_PAINT, observeTileQueue } from './first-paint';

/** Feeds a sequence of tile-queue readings through the latch. */
function feed(counts: number[]) {
  return counts.reduce(observeTileQueue, INITIAL_FIRST_PAINT);
}

describe('observeTileQueue', () => {
  it('is not ready before anything has been requested', () => {
    // The regression this exists for. A fresh Cesium viewer reports
    // tilesLoaded === true and a queue of 0, because it has not asked for
    // anything yet — so treating that as "painted" mounted the earthquake dots
    // against an empty planet.
    expect(feed([]).ready).toBe(false);
    expect(feed([0]).ready).toBe(false);
    expect(feed([0, 0, 0]).ready).toBe(false);
  });

  it('is not ready while tiles are still in flight', () => {
    expect(feed([12]).ready).toBe(false);
    expect(feed([0, 12, 5, 1]).ready).toBe(false);
  });

  it('becomes ready when the queue drains after having filled', () => {
    expect(feed([12, 5, 0]).ready).toBe(true);
  });

  it('tolerates a zero reading before loading starts', () => {
    // Cesium can report an idle queue before the basemap layer has mounted.
    expect(feed([0, 0, 8, 3, 0]).ready).toBe(true);
  });

  it('latches, so a basemap switch does not blink the data layers out', () => {
    const painted = feed([9, 0]);
    expect(painted.ready).toBe(true);

    // Switching basemaps refills the queue; the gate must not reclose.
    const afterSwitch = [40, 22, 3].reduce(observeTileQueue, painted);
    expect(afterSwitch.ready).toBe(true);
  });

  it('returns the same object when nothing changed, so effects do not churn', () => {
    const started = feed([7]);
    expect(observeTileQueue(started, 4)).toBe(started);

    const painted = feed([7, 0]);
    expect(observeTileQueue(painted, 0)).toBe(painted);
  });
});
