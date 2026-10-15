import { create } from 'zustand';
import {
  GNSS_DEFAULT_SPAN,
  type EarthquakeEvent,
  type GnssResult,
  type GnssSpanId,
} from '@terra-pulse/schema';

/** The quake a window was opened for — copied, so it survives the catalogue reloading. */
export interface GnssSubject {
  eventId: string;
  latitude: number;
  longitude: number;
  magnitude: number;
  originUtc: string;
  place: string;
}

/** What came back. `error` is "the lab could not be reached". */
export type GnssOutcome = GnssResult | { status: 'error' };

interface GnssState {
  /**
   * The quake the window shows, or null when it is closed.
   *
   * **The window belongs to its quake, not to the selection.** Selecting
   * another quake leaves it showing the one it was opened for — its title
   * names it — so a reader can keep a station's graph up while clicking around
   * the globe. Opening it from another quake's inspector replaces it.
   */
  subject: GnssSubject | null;

  /**
   * The answer in hand, stored against the quake it describes, as the shaking
   * lines' store does: a slow reply for an earlier quake must not be drawn
   * under a newer one's title.
   */
  loaded: { eventId: string; outcome: GnssOutcome } | null;

  spanId: GnssSpanId;
  /** On by default — the user's choice. Applies to every station in the window. */
  removeDrift: boolean;
  /** Which of the window's stations is showing. */
  stationIndex: number;
  /**
   * Where the window was dragged to, top-left corner in CSS pixels, or null
   * for its opening place. Kept across quakes: having moved it out of the way
   * once, a reader should not have to again.
   */
  position: { x: number; y: number } | null;

  open: (event: Pick<EarthquakeEvent, 'id' | 'latitude' | 'longitude' | 'magnitude' | 'timeUtc' | 'place'>) => void;
  close: () => void;
  setSpan: (spanId: GnssSpanId) => void;
  setRemoveDrift: (removeDrift: boolean) => void;
  setStationIndex: (index: number) => void;
  moveTo: (position: { x: number; y: number }) => void;
}

export const useGnssStore = create<GnssState>((set, get) => ({
  subject: null,
  loaded: null,
  spanId: GNSS_DEFAULT_SPAN,
  removeDrift: true,
  stationIndex: 0,
  position: null,

  open: (event) => {
    const subject: GnssSubject = {
      eventId: event.id,
      latitude: event.latitude,
      longitude: event.longitude,
      magnitude: event.magnitude,
      originUtc: event.timeUtc,
      place: event.place,
    };
    set({ subject, stationIndex: 0 });

    // Asked for here rather than by an effect in the window: there is one
    // asker, and reopening the same quake asks again, which main answers from
    // memory.
    void window.terraPulse.gnss
      .nearQuake({
        eventId: subject.eventId,
        latitude: subject.latitude,
        longitude: subject.longitude,
        magnitude: subject.magnitude,
        originUtc: subject.originUtc,
      })
      .catch((error: unknown): GnssOutcome => {
        console.error('Could not fetch GPS positions', error);
        return { status: 'error' };
      })
      .then((outcome) => {
        if (get().subject?.eventId !== subject.eventId) return;
        set({ loaded: { eventId: subject.eventId, outcome } });
      });
  },

  close: () => set({ subject: null }),
  setSpan: (spanId) => set({ spanId }),
  setRemoveDrift: (removeDrift) => set({ removeDrift }),
  setStationIndex: (stationIndex) => set({ stationIndex }),
  moveTo: (position) => set({ position }),
}));

export type GnssView =
  | { status: 'closed' }
  | { status: 'loading'; subject: GnssSubject }
  | { status: 'ready'; subject: GnssSubject; outcome: GnssOutcome };

/**
 * What the window shows. Pure, so the stale-reply rule is tested without a
 * DOM: an answer is only handed out with the quake it was asked for.
 */
export function gnssView(
  subject: GnssSubject | null,
  loaded: { eventId: string; outcome: GnssOutcome } | null,
): GnssView {
  if (subject === null) return { status: 'closed' };
  if (loaded === null || loaded.eventId !== subject.eventId) return { status: 'loading', subject };
  return { status: 'ready', subject, outcome: loaded.outcome };
}
