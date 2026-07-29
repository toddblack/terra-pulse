import { describe, expect, it } from 'vitest';
import {
  BASEMAP_REGISTRATIONS,
  DEFAULT_BASEMAP_ID,
  OVERLAY_REGISTRATIONS,
  backdropToneFor,
  defaultOverlayVisibility,
  findBasemap,
  isOverlayVisible,
} from './registry';

describe('registry invariants', () => {
  it('has no duplicate ids across every registered layer', () => {
    const ids = [...BASEMAP_REGISTRATIONS, ...OVERLAY_REGISTRATIONS].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('registers at least one basemap, and the default resolves to one', () => {
    expect(BASEMAP_REGISTRATIONS.length).toBeGreaterThan(0);
    expect(findBasemap(DEFAULT_BASEMAP_ID)).toBeDefined();
  });

  it('gives every basemap a declared tone', () => {
    // Layers drawn on top read this; a missing tone would silently fall back
    // to 'light' and make marks unreadable over dark imagery.
    for (const entry of BASEMAP_REGISTRATIONS) {
      expect(['light', 'dark']).toContain(entry.tone);
    }
  });

  it('keeps overlays out of the basemap category', () => {
    // A basemap in the overlay list would be independently toggleable and
    // break the exclusive-group rule.
    for (const entry of OVERLAY_REGISTRATIONS) {
      expect(entry.category).not.toBe('basemap');
    }
  });
});

describe('backdropToneFor', () => {
  it('returns the declared tone of a known basemap', () => {
    expect(backdropToneFor('osm')).toBe('light');
    expect(backdropToneFor('relief')).toBe('dark');
    expect(backdropToneFor('seafloor')).toBe('dark');
  });

  it('declares a tone for every registered basemap', () => {
    // Marks drawn on top pick their colours from this. A basemap without one
    // would silently fall back to 'light' and could put the depth ramp on a
    // background it was never checked against.
    for (const entry of BASEMAP_REGISTRATIONS) {
      expect(backdropToneFor(entry.id)).toBe(entry.tone);
    }
  });

  it('falls back to light for an unknown id rather than throwing', () => {
    // A stale persisted id shouldn't crash the globe.
    expect(backdropToneFor('nope')).toBe('light');
  });
});

describe('visibility helpers', () => {
  it('seeds visibility from each overlay’s declared default', () => {
    const visibility = defaultOverlayVisibility();
    for (const entry of OVERLAY_REGISTRATIONS) {
      expect(visibility[entry.id]).toBe(entry.defaultVisible);
    }
  });

  it('honours an explicit toggle over the default', () => {
    const entry = OVERLAY_REGISTRATIONS[0]!;
    expect(isOverlayVisible(entry, { [entry.id]: false })).toBe(false);
    expect(isOverlayVisible(entry, { [entry.id]: true })).toBe(true);
  });

  it('falls back to the default when a layer has no stored preference', () => {
    // Happens for a layer added after a user's visibility map was seeded.
    const entry = OVERLAY_REGISTRATIONS[0]!;
    expect(isOverlayVisible(entry, {})).toBe(entry.defaultVisible);
  });
});

describe('layer factories', () => {
  it('produce layers whose declared identity matches their registration', () => {
    for (const entry of BASEMAP_REGISTRATIONS) {
      const layer = entry.create();
      expect(layer.id).toBe(entry.id);
      expect(layer.category).toBe(entry.category);
    }

    for (const entry of OVERLAY_REGISTRATIONS) {
      const layer = entry.create({ events: [], backdropTone: 'light' });
      expect(layer.id).toBe(entry.id);
      expect(layer.category).toBe(entry.category);
    }
  });

  it('produce layers satisfying the full GlobeLayer contract', () => {
    const all = [
      ...BASEMAP_REGISTRATIONS.map((entry) => entry.create()),
      ...OVERLAY_REGISTRATIONS.map((entry) => entry.create({ events: [], backdropTone: 'light' })),
    ];

    for (const layer of all) {
      expect(typeof layer.mount).toBe('function');
      expect(typeof layer.unmount).toBe('function');
      expect(typeof layer.setTimeWindow).toBe('function');
      expect(typeof layer.setVisible).toBe('function');
      expect(typeof layer.label).toBe('string');
      expect(typeof layer.defaultVisible).toBe('boolean');
    }
  });
});
