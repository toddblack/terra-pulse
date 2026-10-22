import { describe, expect, it } from 'vitest';
import { parseVersion } from '@terra-pulse/schema';
import { TOUR_STEPS } from './tour-steps';

// Every component's source, as text. Through Vite rather than `node:fs`, so
// this stays an ordinary renderer test with no tsconfig exception.
const sources = Object.values(
  import.meta.glob<string>('../**/*.tsx', { query: '?raw', import: 'default', eager: true }),
).join('\n');

/**
 * Whether an element with this id is rendered anywhere. Most ids are literals;
 * the dock's tabs are built as `dock-tab-${tab.id}` from a list whose ids are
 * written as `id: 'waveforms'`.
 */
function idExists(id: string): boolean {
  if (sources.includes(`id="${id}"`)) return true;
  const tab = /^dock-tab-(.+)$/.exec(id)?.[1];
  return tab !== undefined && sources.includes('id={`dock-tab-${tab.id}`}') && sources.includes(`{ id: '${tab}'`);
}

describe('TOUR_STEPS', () => {
  it.each(TOUR_STEPS.filter((step) => step.target !== null).map((step) => [step.id, step.target]))(
    "step %s points at an element that exists (#%s) — a renamed id would silently drop it",
    (_id, target) => {
      expect(idExists(target ?? '')).toBe(true);
    },
  );

  it('gives every step a parseable version, or tourStepsToShow would quietly skip it as what-s-new', () => {
    for (const step of TOUR_STEPS) expect(parseVersion(step.addedIn), step.id).not.toBeNull();
  });

  it('uses each id once', () => {
    expect(new Set(TOUR_STEPS.map((step) => step.id)).size).toBe(TOUR_STEPS.length);
  });

  it('opens on a centred welcome, so the first thing a new reader meets is not a panel', () => {
    expect(TOUR_STEPS[0]?.target).toBeNull();
  });
});
