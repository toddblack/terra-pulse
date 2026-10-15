import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GnssResult } from '@terra-pulse/schema';
import { gnssView, useGnssStore, type GnssSubject } from './useGnssStore';

const SUBJECT: GnssSubject = {
  eventId: 'ci38457511',
  latitude: 35.77,
  longitude: -117.6,
  magnitude: 7.1,
  originUtc: '2019-07-06T03:19:53.000Z',
  place: 'Ridgecrest',
};

const event = (id: string) => ({
  id,
  latitude: 35.77,
  longitude: -117.6,
  magnitude: 7.1,
  timeUtc: '2019-07-06T03:19:53.000Z',
  place: id,
});

const NONE = (reachKm: number): GnssResult => ({ status: 'none', reachKm, nearestKm: null });

beforeEach(() => {
  useGnssStore.setState({ subject: null, loaded: null, stationIndex: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gnssView', () => {
  it('is closed with no quake', () => {
    expect(gnssView(null, null).status).toBe('closed');
  });

  it("never hands out another quake's stations", () => {
    const view = gnssView(SUBJECT, { eventId: 'other', outcome: NONE(1) });
    expect(view.status).toBe('loading');
  });

  it('hands out the answer once it belongs to the open quake', () => {
    expect(gnssView(SUBJECT, { eventId: SUBJECT.eventId, outcome: NONE(1) }).status).toBe('ready');
  });
});

describe('opening', () => {
  it('drops a slow reply for a quake no longer open', async () => {
    const resolvers: Record<string, (r: GnssResult) => void> = {};
    vi.stubGlobal('window', {
      terraPulse: {
        gnss: {
          nearQuake: ({ eventId }: { eventId: string }) =>
            new Promise<GnssResult>((resolve) => {
              resolvers[eventId] = resolve;
            }),
        },
      },
    });

    useGnssStore.getState().open(event('first'));
    useGnssStore.getState().open(event('second'));
    resolvers['second']?.(NONE(2));
    resolvers['first']?.(NONE(1));
    await new Promise((r) => setTimeout(r, 0));

    expect(useGnssStore.getState().loaded).toEqual({ eventId: 'second', outcome: NONE(2) });
  });

  it('turns a failed request into an error, not "no station"', async () => {
    vi.stubGlobal('window', {
      terraPulse: { gnss: { nearQuake: () => Promise.reject(new Error('down')) } },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useGnssStore.getState().open(event('x'));
    await new Promise((r) => setTimeout(r, 0));
    expect(useGnssStore.getState().loaded?.outcome).toEqual({ status: 'error' });
  });

  it('starts each quake on its nearest station', () => {
    vi.stubGlobal('window', { terraPulse: { gnss: { nearQuake: () => new Promise(() => undefined) } } });
    useGnssStore.setState({ stationIndex: 2 });
    useGnssStore.getState().open(event('x'));
    expect(useGnssStore.getState().stationIndex).toBe(0);
  });
});
