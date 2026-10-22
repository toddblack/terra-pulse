import { describe, expect, it } from 'vitest';
import { placeCard } from './tour-layout';

const viewport = { width: 1600, height: 1000 };
const card = { width: 320, height: 180 };

describe('placeCard', () => {
  it('centres the card when there is no target', () => {
    expect(placeCard(null, card, viewport)).toEqual({ left: 640, top: 410, side: 'centre' });
  });

  it('puts a card for the left column to its right, level with it', () => {
    const placement = placeCard({ left: 16, top: 16, width: 240, height: 360 }, card, viewport);
    expect(placement.side).toBe('right');
    expect(placement.left).toBe(16 + 240 + 14);
    expect(placement.top).toBe(16 + 180 - 90);
  });

  it('puts a card for the right column to its left', () => {
    const placement = placeCard({ left: 1340, top: 560, width: 230, height: 330 }, card, viewport);
    expect(placement.side).toBe('left');
    expect(placement.left + card.width).toBe(1340 - 14);
  });

  it('goes above a full-width dock when neither side has room', () => {
    const placement = placeCard({ left: 0, top: 560, width: 1600, height: 380 }, card, viewport);
    expect(placement.side).toBe('above');
    expect(placement.top + card.height).toBe(560 - 14);
  });

  it('holds the card inside the window when the target is near an edge', () => {
    const placement = placeCard({ left: 16, top: 950, width: 200, height: 40 }, card, viewport);
    expect(placement.top + card.height).toBeLessThanOrEqual(viewport.height - 12);
    expect(placement.top).toBeGreaterThanOrEqual(12);
  });

  it('falls back to the centre when no side has room', () => {
    const placement = placeCard({ left: 0, top: 0, width: 1600, height: 1000 }, card, viewport);
    expect(placement.side).toBe('centre');
  });
});
