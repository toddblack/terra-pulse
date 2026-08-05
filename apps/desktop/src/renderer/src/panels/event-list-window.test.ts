import { describe, expect, it } from 'vitest';
import { OVERSCAN_ROWS, ROW_HEIGHT_PX, totalHeightPx, visibleRange } from './event-list-window';

const VIEWPORT = 260; // ten rows at the current row height

describe('visibleRange', () => {
  it('renders only a screenful plus overscan, however long the list', () => {
    // The whole point. The all-years archive view is 26,746 rows; rendering
    // them as elements is tens of thousands of DOM nodes for a panel a few
    // hundred pixels tall.
    const { first, end } = visibleRange(0, VIEWPORT, 26_746);

    expect(first).toBe(0);
    expect(end - first).toBeLessThan(40);
  });

  it('follows the scroll position', () => {
    const { first, offsetTop } = visibleRange(ROW_HEIGHT_PX * 100, VIEWPORT, 1_000);

    expect(first).toBe(100 - OVERSCAN_ROWS);
    // The offset must match the first rendered row exactly, or every row is
    // drawn at the wrong height and the list appears to drift as you scroll.
    expect(offsetTop).toBe(first * ROW_HEIGHT_PX);
  });

  it('never starts before the list does', () => {
    // Overscan would push `first` negative near the top, and a negative slice
    // index silently returns the wrong rows.
    expect(visibleRange(0, VIEWPORT, 500).first).toBe(0);
    expect(visibleRange(ROW_HEIGHT_PX * 2, VIEWPORT, 500).first).toBe(0);
  });

  it('never runs past the end', () => {
    const total = 30;
    const { end } = visibleRange(ROW_HEIGHT_PX * 25, VIEWPORT, total);

    expect(end).toBeLessThanOrEqual(total);
  });

  it('survives a negative scrollTop', () => {
    // macOS overscroll reports these. An unclamped value indexes off the front.
    const { first, offsetTop } = visibleRange(-120, VIEWPORT, 500);

    expect(first).toBe(0);
    expect(offsetTop).toBe(0);
  });

  it('survives a scroll position past a list that just shrank', () => {
    // Raising the magnitude floor can cut the list from 8,000 rows to 40 while
    // the scroller still reports the old offset.
    const { first, end } = visibleRange(ROW_HEIGHT_PX * 5_000, VIEWPORT, 40);

    expect(first).toBeGreaterThanOrEqual(0);
    expect(end).toBeLessThanOrEqual(40);
    expect(end).toBeGreaterThanOrEqual(first);
  });

  it('renders nothing for an empty list', () => {
    expect(visibleRange(0, VIEWPORT, 0)).toEqual({ first: 0, end: 0, offsetTop: 0 });
  });

  it('still renders rows when the viewport has not been measured', () => {
    // The regression. A stale ResizeObserver left the height at 0, and
    // returning an empty slice for that turned a full list into a blank box
    // with a working scrollbar — visibly broken, and not obviously a
    // measurement problem. A zero height now falls back to a screenful:
    // rendering a few rows too many is invisible, rendering none is a dead
    // panel.
    const { first, end } = visibleRange(0, 0, 500);

    expect(first).toBe(0);
    expect(end).toBeGreaterThan(0);
  });

  it('covers the viewport with no gap at any scroll position', () => {
    // Walks a long list and asserts the rendered slice always spans what the
    // viewport can see — a gap here is a blank band mid-scroll.
    const total = 5_000;
    for (let scrollTop = 0; scrollTop < total * ROW_HEIGHT_PX; scrollTop += 137) {
      const { first, end } = visibleRange(scrollTop, VIEWPORT, total);
      const firstVisible = Math.floor(scrollTop / ROW_HEIGHT_PX);
      const lastVisible = Math.min(
        total - 1,
        Math.floor((scrollTop + VIEWPORT) / ROW_HEIGHT_PX),
      );

      expect(first).toBeLessThanOrEqual(firstVisible);
      expect(end).toBeGreaterThan(lastVisible);
    }
  });
});

describe('totalHeightPx', () => {
  it('describes the whole list so the scrollbar does not lie', () => {
    expect(totalHeightPx(1_000)).toBe(1_000 * ROW_HEIGHT_PX);
  });

  it('is zero, not negative, for an empty list', () => {
    expect(totalHeightPx(0)).toBe(0);
    expect(totalHeightPx(-5)).toBe(0);
  });
});
