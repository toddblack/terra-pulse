import type { TourStepVersioning } from '@terra-pulse/schema';

/**
 * The first-run tour, in order.
 *
 * **Adding a feature worth announcing:** add its step here with `addedIn` set
 * to the release that ships it and `whatsNew: true`. A fresh install meets it
 * in place; an existing user sees just that step, once, on the update. Leave
 * `whatsNew` off for a step that only rewords or reorders the tour — existing
 * users should not be interrupted to read about what they already use.
 *
 * Every `target` is an element id that already exists in the app, and
 * `tour-steps.test.ts` fails if one is renamed out from under the tour.
 *
 * The words are Explore's: they describe what is drawn and make no claim that
 * anything is related to anything (non-negotiable #1, and
 * `explore-purity.test.ts` reads this directory too).
 */
export interface TourStep extends TourStepVersioning {
  id: string;
  /** The element to highlight, by id; null for a card in the middle of the window. */
  target: string | null;
  title: string;
  body: string;
  /**
   * Something the tour does on arriving at this step. Only one exists, and the
   * tour does nothing else to the app: it points.
   */
  action?: 'select-largest-quake';
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    target: null,
    title: 'Welcome to Terra Pulse',
    body: 'Every dot on the globe is a recorded earthquake. Colour is depth, size is magnitude, and a red outline means the last 24 hours. Drag to turn the globe, scroll to zoom, and click a dot to look closer.',
    addedIn: '0.2.0',
  },
  {
    id: 'range',
    target: 'range-controls',
    title: 'What is shown',
    body: 'Choose the smallest magnitude to show and how far back to look. History reaches back decades — to 1900 for the largest quakes — once its archive is downloaded below. Or pick exact dates.',
    addedIn: '0.2.0',
  },
  {
    id: 'layers',
    target: 'layer-panel',
    title: 'Layers',
    body: 'Plate boundaries, faults, the magnetic field, aurora, the ionosphere, tides and more. Every ? explains how to read a layer and, just as important, what it cannot tell you.',
    addedIn: '0.2.0',
  },
  {
    id: 'inspector',
    target: 'earthquake-inspector',
    title: 'One earthquake, up close',
    body: 'Clicking a quake opens this panel: what followed it, the point on the opposite side of the planet, the nearest mapped fault, and how often quakes like it happen nearby. Larger quakes add a replay of their seismic waves and nearby GPS.',
    addedIn: '0.2.0',
    action: 'select-largest-quake',
  },
  {
    id: 'timeline',
    target: 'bottom-dock',
    title: 'The timeline',
    body: 'Press play to watch the window unfold. Below it, solar wind, geomagnetic storms, solar flares and tides run on the same clock as the earthquakes.',
    addedIn: '0.2.0',
  },
  {
    id: 'waveforms',
    target: 'dock-tab-waveforms',
    title: 'Live seismic waves',
    body: 'Ground motion streaming now from seismometers around the world. On this tab, click anywhere on the globe to see the stations around that spot, and use Watch this spot to be alerted when a nearby quake is likely to be felt there.',
    addedIn: '0.2.0',
  },
  {
    id: 'modes',
    target: 'mode-switch',
    title: 'Explore and Analyze',
    body: 'Explore shows the data and draws no conclusions. Analyze runs statistical tests that were written down before any data was looked at. The house button brings the globe back to where it started.',
    addedIn: '0.2.0',
  },
  {
    id: 'about',
    target: 'about-button',
    title: 'That is the tour',
    body: 'Take it again any time from here.',
    addedIn: '0.2.0',
  },
];
