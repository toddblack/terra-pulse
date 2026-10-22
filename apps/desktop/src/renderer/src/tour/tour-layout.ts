/**
 * Where the tour's caption card goes, beside the thing it points at. Pure, so
 * the placement rules are tested without a DOM.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type CardSide = 'right' | 'left' | 'below' | 'above' | 'centre';

export interface CardPlacement {
  left: number;
  top: number;
  side: CardSide;
}

/** Space between the highlighted target and the card. */
const GAP = 14;
/** Nearest the card may come to the window's edge. */
const GUTTER = 12;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * The card beside the target, on the first side with room for it — right,
 * left, below, above — and centred on the target along that side, then held
 * inside the window. Every panel here sits against a window edge (the columns
 * left and right, the dock at the bottom, the mode switch at the top), so the
 * open side is almost always the one facing the globe.
 *
 * With no target, or no side with room, the card is centred in the window:
 * covering part of the target beats a card hanging off-screen.
 */
export function placeCard(target: Box | null, card: { width: number; height: number }, viewport: { width: number; height: number }): CardPlacement {
  const centred: CardPlacement = {
    left: Math.round((viewport.width - card.width) / 2),
    top: Math.round((viewport.height - card.height) / 2),
    side: 'centre',
  };
  if (target === null) return centred;

  const maxLeft = viewport.width - card.width - GUTTER;
  const maxTop = viewport.height - card.height - GUTTER;
  const besideTop = clamp(target.top + target.height / 2 - card.height / 2, GUTTER, maxTop);
  const besideLeft = clamp(target.left + target.width / 2 - card.width / 2, GUTTER, maxLeft);

  const right = target.left + target.width + GAP;
  if (right + card.width + GUTTER <= viewport.width) return { left: right, top: besideTop, side: 'right' };

  const left = target.left - GAP - card.width;
  if (left >= GUTTER) return { left, top: besideTop, side: 'left' };

  const below = target.top + target.height + GAP;
  if (below + card.height + GUTTER <= viewport.height) return { left: besideLeft, top: below, side: 'below' };

  const above = target.top - GAP - card.height;
  if (above >= GUTTER) return { left: besideLeft, top: above, side: 'above' };

  return centred;
}
