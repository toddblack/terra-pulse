/**
 * Which rows of a long list are worth rendering. Pure, so the arithmetic can be
 * tested without a DOM.
 *
 * The list mirrors whatever the globe is showing, which is 7,900 rows at
 * 30d/M2.5 and 26,746 in the all-years archive view. Rendering those as real
 * elements is tens of thousands of DOM nodes for a panel a few hundred pixels
 * tall — so only the visible slice exists, and a spacer of the full height
 * makes the scrollbar behave as though the rest does too.
 *
 * Windowing rather than capping: a cap would silently hide most of the
 * catalogue and make the scrollbar lie about how much there is.
 */

/** Must match `.row` height in the stylesheet, or scrolling drifts. */
export const ROW_HEIGHT_PX = 26;

/**
 * Rows rendered beyond each edge of the viewport.
 *
 * Without any, a fast scroll paints blank space for a frame before React
 * catches up. Eight rows is about a third of a screenful here — enough to cover
 * a flick, cheap enough not to matter.
 */
export const OVERSCAN_ROWS = 8;

export interface VisibleRange {
  /** Inclusive index of the first row to render. */
  first: number;
  /** Exclusive — suitable for `slice`. */
  end: number;
  /** Pixels of empty space standing in for the rows above `first`. */
  offsetTop: number;
}

/**
 * Used when the viewport hasn't been measured yet.
 *
 * A zero measurement must not mean "render nothing". It happened: the scroller
 * unmounted for an empty list, its ResizeObserver reported 0x0 on the way out,
 * and the height stayed 0 after the element came back — so the panel showed a
 * growing scrollbar over a blank box until it was closed and reopened. The
 * measurement bug is fixed, but the failure mode is worth designing out too:
 * rendering a screenful too many is invisible, rendering none is a dead panel.
 */
const UNMEASURED_VIEWPORT_PX = 600;

export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  totalRows: number,
  rowHeight: number = ROW_HEIGHT_PX,
  overscan: number = OVERSCAN_ROWS,
): VisibleRange {
  if (totalRows <= 0 || rowHeight <= 0) {
    return { first: 0, end: 0, offsetTop: 0 };
  }

  const height = viewportHeight > 0 ? viewportHeight : UNMEASURED_VIEWPORT_PX;

  // Clamped because browsers report negative scrollTop during overscroll on
  // macOS and past-the-end values while the list is shrinking under a filter
  // change — both would otherwise index outside the array.
  const safeScrollTop = Math.max(0, scrollTop);

  const visibleRows = Math.ceil(height / rowHeight) + overscan * 2;

  // Clamped at *both* ends. The upper clamp is the one that isn't obvious:
  // raising the magnitude floor can cut the list from 8,000 rows to 40 while
  // the scroller still reports the old offset, which put `first` past `end` and
  // made `slice` return nothing — a blank panel that looks broken until you
  // touch the scrollbar. Pinning to the last screenful renders real rows
  // instead, and the browser corrects the scroll position a frame later.
  const lastPossibleFirst = Math.max(0, totalRows - visibleRows);
  const first = Math.min(
    lastPossibleFirst,
    Math.max(0, Math.floor(safeScrollTop / rowHeight) - overscan),
  );
  const end = Math.min(totalRows, first + visibleRows);

  return { first, end, offsetTop: first * rowHeight };
}

/** Total scrollable height, so the scrollbar reflects the whole list. */
export function totalHeightPx(totalRows: number, rowHeight: number = ROW_HEIGHT_PX): number {
  return Math.max(0, totalRows) * rowHeight;
}
