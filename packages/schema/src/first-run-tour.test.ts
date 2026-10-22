import { describe, expect, it } from 'vitest';
import { tourNeedsRecording, tourStepsToShow, type TourStatus } from './first-run-tour';

const steps = [
  { id: 'globe', addedIn: '0.1.6' },
  { id: 'layers', addedIn: '0.1.6' },
  { id: 'later-feature', addedIn: '0.2.0', whatsNew: true },
  { id: 'later-quiet', addedIn: '0.2.0' },
];

const status = (overrides: Partial<TourStatus>): TourStatus => ({
  freshInstall: false,
  seenVersion: null,
  currentVersion: '0.2.0',
  ...overrides,
});

const ids = (list: readonly { id: string }[]) => list.map((step) => step.id);

describe('tourStepsToShow', () => {
  it('shows a fresh install every step, what-s-new ones included, in order', () => {
    expect(ids(tourStepsToShow(steps, status({ freshInstall: true })))).toEqual([
      'globe',
      'layers',
      'later-feature',
      'later-quiet',
    ]);
  });

  it('shows nothing to someone who was using the app before the tour existed', () => {
    expect(tourStepsToShow(steps, status({ freshInstall: false, seenVersion: null }))).toEqual([]);
  });

  it('shows only what-s-new steps added after the version last toured', () => {
    expect(ids(tourStepsToShow(steps, status({ seenVersion: '0.1.6' })))).toEqual(['later-feature']);
  });

  it('shows nothing once the current version has been toured', () => {
    expect(tourStepsToShow(steps, status({ seenVersion: '0.2.0' }))).toEqual([]);
  });

  it('does not re-run the full tour for a fresh install that already finished it', () => {
    // Finished the tour, then quit before the first poll wrote a watermark.
    expect(tourStepsToShow(steps, status({ freshInstall: true, seenVersion: '0.2.0' }))).toEqual([]);
  });

  it('fails toward showing nothing when a version does not parse', () => {
    expect(tourStepsToShow(steps, status({ seenVersion: 'garbage' }))).toEqual([]);
    expect(tourStepsToShow([{ id: 'x', addedIn: 'soon', whatsNew: true }], status({ seenVersion: '0.1.6' }))).toEqual(
      [],
    );
  });
});

describe('tourNeedsRecording', () => {
  it('records an upgrader with no tour history, so later what-s-new is measured from now', () => {
    expect(tourNeedsRecording(status({ seenVersion: null }))).toBe(true);
    expect(tourNeedsRecording(status({ seenVersion: '0.1.6' }))).toBe(true);
    expect(tourNeedsRecording(status({ seenVersion: '0.2.0' }))).toBe(false);
  });
});
