/**
 * Remembering the window's size and position between launches.
 *
 * Pure and Electron-free so the awkward parts — a saved position on a monitor
 * that no longer exists, a maximised window saving its maximised size as its
 * restore size — can be tested without a display. The wiring (the `screen`
 * module, the event listeners) lives in `index.ts`.
 */

/** A rectangle, in the same shape Electron's display and window bounds use. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StoredWindowBounds extends Rect {
  /** Restored maximised, with the rectangle as the size to un-maximise to. */
  maximized: boolean;
}

/**
 * How much of the window must overlap a display for the position to be reused.
 *
 * Not "any overlap": a window one pixel onto the screen is as unreachable as one
 * fully off it. This is roughly a grabbable strip of title bar — enough that the
 * window can be dragged back into view by hand.
 */
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 40;

/**
 * Reads what was stored, rejecting anything that is not a complete, finite,
 * positive rectangle.
 *
 * Deliberately strict. The stored value is JSON from an earlier version of this
 * app, so a field could be missing or a shape could have changed — and a
 * `NaN` width reaches `BrowserWindow` as a window that never appears, which is
 * a very confusing failure for something this peripheral.
 */
export function parseWindowBounds(raw: string | null): StoredWindowBounds | null {
  if (raw === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;

  const numbers = ['x', 'y', 'width', 'height'] as const;
  for (const key of numbers) {
    if (typeof candidate[key] !== 'number' || !Number.isFinite(candidate[key])) return null;
  }
  if ((candidate.width as number) <= 0 || (candidate.height as number) <= 0) return null;

  return {
    x: candidate.x as number,
    y: candidate.y as number,
    width: candidate.width as number,
    height: candidate.height as number,
    maximized: candidate.maximized === true,
  };
}

export function serialiseWindowBounds(bounds: StoredWindowBounds): string {
  return JSON.stringify(bounds);
}

/** Whether a grabbable part of the rectangle falls on any display. */
export function isOnSomeDisplay(bounds: Rect, displays: readonly Rect[]): boolean {
  return displays.some((display) => {
    const overlapWidth =
      Math.min(bounds.x + bounds.width, display.x + display.width) -
      Math.max(bounds.x, display.x);
    const overlapHeight =
      Math.min(bounds.y + bounds.height, display.y + display.height) -
      Math.max(bounds.y, display.y);
    return overlapWidth >= MIN_VISIBLE_WIDTH && overlapHeight >= MIN_VISIBLE_HEIGHT;
  });
}

/** What `new BrowserWindow(...)` should be given, given what was stored. */
export interface WindowPlacement {
  width: number;
  height: number;
  /** Omitted when the position is not reusable — Electron then centres it. */
  x?: number;
  y?: number;
  maximized: boolean;
}

/**
 * Turns a stored rectangle into placement options, or falls back to defaults.
 *
 * ## The size is kept even when the position is not
 *
 * A monitor being unplugged, or a laptop docking and undocking, routinely
 * leaves a saved position pointing at coordinates no display covers any more —
 * and a window restored there opens genuinely invisible, with no obvious way to
 * get it back. When that happens the **size is still honoured** and only the
 * position is dropped, so the window centres at the size the reader chose
 * rather than resetting to the default as well.
 *
 * The size is also clamped to the largest display: restoring a 3840-wide window
 * onto a 1920-wide laptop screen is not useful, and the minimum is enforced
 * because a stored value could predate a raise to `minWidth`.
 */
export function placeWindow(
  stored: StoredWindowBounds | null,
  displays: readonly Rect[],
  defaults: { width: number; height: number; minWidth: number; minHeight: number },
): WindowPlacement {
  if (stored === null || displays.length === 0) {
    return { width: defaults.width, height: defaults.height, maximized: false };
  }

  const widest = Math.max(...displays.map((d) => d.width));
  const tallest = Math.max(...displays.map((d) => d.height));

  const width = clamp(stored.width, defaults.minWidth, widest);
  const height = clamp(stored.height, defaults.minHeight, tallest);

  // Checked against the *clamped* size: a window narrowed to fit the display
  // may now sit differently relative to it than the stored rectangle did.
  const placement: WindowPlacement = { width, height, maximized: stored.maximized };
  if (isOnSomeDisplay({ x: stored.x, y: stored.y, width, height }, displays)) {
    placement.x = stored.x;
    placement.y = stored.y;
  }

  return placement;
}

function clamp(value: number, low: number, high: number): number {
  // `high` can fall below `low` on a display smaller than the minimum window,
  // in which case the minimum wins — an unreachable edge, but Math.min/max
  // compose the wrong way round without saying so.
  return Math.max(low, Math.min(value, Math.max(high, low)));
}
