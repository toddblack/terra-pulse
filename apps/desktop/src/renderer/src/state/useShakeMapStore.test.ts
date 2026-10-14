import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShakeMapResult } from '@terra-pulse/schema';
import { shakeMapView, useShakeMapStore, type ShakeMapOutcome } from './useShakeMapStore';

function available(eventId: string): ShakeMapResult & { status: 'available' } {
  return {
    status: 'available',
    map: { eventId, maxMmi: 7, source: 'us', version: '1', processedAtUtc: null, contours: [] },
  };
}

const BIG = { id: 'us-big', magnitude: 7.1, source: 'usgs' as const };
const OTHER = { id: 'us-other', magnitude: 6.2, source: 'usgs' as const };
const SMALL = { id: 'us-small', magnitude: 4.8, source: 'usgs' as const };
const FROM_EMSC = { id: 'emsc:20261013_0000368', magnitude: 6.0, source: 'emsc' as const };

beforeEach(() => {
  useShakeMapStore.setState({ enabled: false, frameRequest: 0, wantedEventId: null, loaded: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shakeMapView', () => {
  const loaded = { eventId: BIG.id, outcome: available(BIG.id) as ShakeMapOutcome };

  it('is off until the lines are switched on', () => {
    expect(shakeMapView(false, BIG, loaded).status).toBe('off');
  });

  it('is off with nothing selected', () => {
    expect(shakeMapView(true, null, loaded).status).toBe('off');
  });

  it('says a small quake is not one that gets lines', () => {
    expect(shakeMapView(true, SMALL, null).status).toBe('ineligible');
  });

  it('says the same for a quake USGS cannot look up', () => {
    // An EMSC-sourced event carries EMSC's id.
    expect(shakeMapView(true, FROM_EMSC, null).status).toBe('ineligible');
  });

  it('is loading until an answer for this quake is in hand', () => {
    expect(shakeMapView(true, BIG, null).status).toBe('loading');
  });

  it("never hands out another quake's lines", () => {
    // The failure this guards against looks entirely normal on screen: one
    // earthquake's isoseismals drawn around a different epicentre.
    const view = shakeMapView(true, OTHER, loaded);
    expect(view.status).toBe('loading');
  });

  it('hands out the map once it belongs to the selected quake', () => {
    const view = shakeMapView(true, BIG, loaded);
    expect(view.status).toBe('available');
    expect(view.status === 'available' && view.map.eventId).toBe(BIG.id);
  });

  it('passes "no map" and "could not reach USGS" through as different answers', () => {
    expect(shakeMapView(true, BIG, { eventId: BIG.id, outcome: { status: 'none' } }).status).toBe(
      'none',
    );
    expect(shakeMapView(true, BIG, { eventId: BIG.id, outcome: { status: 'error' } }).status).toBe(
      'error',
    );
  });
});

describe('the switch', () => {
  it('starts off, so nothing is asked of USGS unprompted', () => {
    expect(useShakeMapStore.getState().enabled).toBe(false);
  });

  it('asks the globe to frame the lines each time it is switched on', () => {
    useShakeMapStore.getState().setEnabled(true);
    expect(useShakeMapStore.getState().frameRequest).toBe(1);

    useShakeMapStore.getState().setEnabled(false);
    // Switching off is not a request to move the camera.
    expect(useShakeMapStore.getState().frameRequest).toBe(1);

    useShakeMapStore.getState().setEnabled(true);
    expect(useShakeMapStore.getState().frameRequest).toBe(2);
  });
});

describe('load', () => {
  function stubContours(impl: (eventId: string) => Promise<ShakeMapResult>) {
    vi.stubGlobal('window', { terraPulse: { shakeMap: { contours: impl } } });
  }

  it('stores the answer against the quake it was asked for', async () => {
    stubContours((id) => Promise.resolve(available(id)));
    await useShakeMapStore.getState().load(BIG.id);

    const { loaded } = useShakeMapStore.getState();
    expect(loaded?.eventId).toBe(BIG.id);
    expect(loaded?.outcome.status).toBe('available');
  });

  it('records a failed request as an error rather than as "no map"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubContours(() => Promise.reject(new Error('offline')));
    await useShakeMapStore.getState().load(BIG.id);

    expect(useShakeMapStore.getState().loaded?.outcome).toEqual({ status: 'error' });
  });

  it('ignores a slow reply for a quake that is no longer the one wanted', async () => {
    // Click A, then B. B answers first; A's answer lands afterwards. Without
    // the check A would overwrite B's, and B — still selected — would sit on
    // "loading" for good, because its own reply had already come and gone.
    const release = new Map<string, (result: ShakeMapResult) => void>();
    stubContours(
      (id) =>
        new Promise<ShakeMapResult>((resolve) => {
          release.set(id, resolve);
        }),
    );

    const first = useShakeMapStore.getState().load(BIG.id);
    const second = useShakeMapStore.getState().load(OTHER.id);

    release.get(OTHER.id)?.(available(OTHER.id));
    await second;
    release.get(BIG.id)?.(available(BIG.id));
    await first;

    expect(useShakeMapStore.getState().loaded?.eventId).toBe(OTHER.id);
    expect(shakeMapView(true, OTHER, useShakeMapStore.getState().loaded).status).toBe('available');
  });
});
