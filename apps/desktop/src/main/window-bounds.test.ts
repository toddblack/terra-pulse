import { describe, expect, it } from 'vitest';
import {
  isOnSomeDisplay,
  parseWindowBounds,
  placeWindow,
  serialiseWindowBounds,
  type Rect,
} from './window-bounds';

/** A 1080p primary, and a second monitor to its left as often happens. */
const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
const SECONDARY: Rect = { x: -1920, y: 0, width: 1920, height: 1080 };

const DEFAULTS = { width: 1600, height: 1000, minWidth: 1000, minHeight: 600 };

describe('parseWindowBounds', () => {
  it('round-trips what it writes', () => {
    const bounds = { x: 40, y: 60, width: 1600, height: 1000, maximized: false };
    expect(parseWindowBounds(serialiseWindowBounds(bounds))).toEqual(bounds);
  });

  it('returns null for nothing stored', () => {
    expect(parseWindowBounds(null)).toBeNull();
  });

  it('rejects malformed or incomplete values rather than passing them on', () => {
    // The stored value is JSON written by an earlier version of this app, so a
    // field can be missing or a shape can have changed. A NaN width reaches
    // BrowserWindow as a window that never appears — a very confusing failure
    // for something this peripheral.
    expect(parseWindowBounds('not json')).toBeNull();
    expect(parseWindowBounds('null')).toBeNull();
    expect(parseWindowBounds('[]')).toBeNull();
    expect(parseWindowBounds('{"x":0,"y":0,"width":800}')).toBeNull();
    expect(parseWindowBounds('{"x":0,"y":0,"width":null,"height":600}')).toBeNull();
    expect(parseWindowBounds('{"x":0,"y":0,"width":0,"height":600}')).toBeNull();
  });

  it('treats a missing maximized flag as not maximized', () => {
    expect(parseWindowBounds('{"x":0,"y":0,"width":1600,"height":1000}')?.maximized).toBe(false);
  });
});

describe('isOnSomeDisplay', () => {
  it('accepts a window on the primary display', () => {
    expect(isOnSomeDisplay({ x: 100, y: 100, width: 1600, height: 1000 }, [PRIMARY])).toBe(true);
  });

  it('accepts a window on a second display at negative coordinates', () => {
    // The common multi-monitor layout, and the one a naive `x >= 0` check
    // would throw away every launch.
    expect(isOnSomeDisplay({ x: -1800, y: 50, width: 1600, height: 1000 }, [PRIMARY, SECONDARY]))
      .toBe(true);
  });

  it('rejects a window on a display that is gone', () => {
    // Undock a laptop and the saved position points at nothing. Restored
    // there, the window opens genuinely invisible.
    expect(isOnSomeDisplay({ x: -1800, y: 50, width: 1600, height: 1000 }, [PRIMARY])).toBe(false);
  });

  it('rejects a sliver too small to grab', () => {
    // Not "any overlap": a window one pixel onto the screen is as unreachable
    // as one fully off it. This needs a grabbable strip of title bar.
    expect(isOnSomeDisplay({ x: 1919, y: 100, width: 1600, height: 1000 }, [PRIMARY])).toBe(false);
    expect(isOnSomeDisplay({ x: 1700, y: 100, width: 1600, height: 1000 }, [PRIMARY])).toBe(true);
  });
});

describe('placeWindow', () => {
  it('falls back to the default size on a first run', () => {
    expect(placeWindow(null, [PRIMARY], DEFAULTS)).toEqual({
      width: 1600,
      height: 1000,
      maximized: false,
    });
  });

  it('restores a remembered size and position', () => {
    const stored = { x: 120, y: 80, width: 1400, height: 900, maximized: false };
    expect(placeWindow(stored, [PRIMARY], DEFAULTS)).toEqual({
      x: 120,
      y: 80,
      width: 1400,
      height: 900,
      maximized: false,
    });
  });

  it('keeps the size but drops an unreachable position', () => {
    // The point of separating the two: a monitor being unplugged should not
    // also reset the size the reader chose.
    const stored = { x: -1800, y: 50, width: 1400, height: 900, maximized: false };
    const placement = placeWindow(stored, [PRIMARY], DEFAULTS);

    expect(placement.width).toBe(1400);
    expect(placement.height).toBe(900);
    // Absent, so Electron centres it on a display that exists.
    expect(placement.x).toBeUndefined();
    expect(placement.y).toBeUndefined();
  });

  it('clamps a window larger than any display', () => {
    // Saved on a 4K monitor, reopened on a laptop.
    const stored = { x: 0, y: 0, width: 3840, height: 2160, maximized: false };
    const placement = placeWindow(stored, [PRIMARY], DEFAULTS);
    expect(placement.width).toBe(1920);
    expect(placement.height).toBe(1080);
  });

  it('enforces the minimum, which a stored value may predate', () => {
    const stored = { x: 0, y: 0, width: 300, height: 200, maximized: false };
    const placement = placeWindow(stored, [PRIMARY], DEFAULTS);
    expect(placement.width).toBe(DEFAULTS.minWidth);
    expect(placement.height).toBe(DEFAULTS.minHeight);
  });

  it('carries the maximized flag through', () => {
    const stored = { x: 0, y: 0, width: 1400, height: 900, maximized: true };
    expect(placeWindow(stored, [PRIMARY], DEFAULTS).maximized).toBe(true);
    // ...and the rectangle is still the *un*-maximised size, which is what
    // makes un-maximising restore to something sensible.
    expect(placeWindow(stored, [PRIMARY], DEFAULTS).width).toBe(1400);
  });

  it('falls back when there are no displays at all', () => {
    const stored = { x: 0, y: 0, width: 1400, height: 900, maximized: false };
    expect(placeWindow(stored, [], DEFAULTS)).toEqual({
      width: 1600,
      height: 1000,
      maximized: false,
    });
  });
});
