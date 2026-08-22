/// <reference types="vite/client" />

import type {
  MagnetometerReading,
  TecGrid,
  AftershockSequence,
  AuroraGrid,
  SpaceWeatherProgress,
  SpaceWeatherSample,
  AntipodalWindow,
  AnalysisRunOutcome,
  ArchiveProgress,
  CmeArrival,
  DonkiProgress,
  GoesFlareProgress,
  GcmtProgress,
  EarthquakeEvent,
  EarthquakeQuery,
  EarthquakeSyncResult,
  EngineStatus,
  HypothesisId,
  HypothesisSummary,
  MissedEvents,
  RegionalRecurrence,
  SolarFlare,
} from '@terra-pulse/schema';

export {};

declare global {
  interface Window {
    terraPulse: {
      earthquakes: {
        query(query?: EarthquakeQuery): Promise<EarthquakeEvent[]>;
        /** Polls USGS now. Returns the sync result, not the catalogue. */
        refresh(): Promise<EarthquakeSyncResult>;
        /** Subscribe to main's poll results; returns an unsubscribe function. */
        onUpdated(callback: (result: EarthquakeSyncResult) => void): () => void;
        /** Subscribe to large-event alerts; returns an unsubscribe function. */
        onLargeEvent(callback: (event: EarthquakeEvent) => void): () => void;
        /**
         * The alert announced but not dismissed, or null.
         *
         * Covers the launch poll, which fires before `onLargeEvent` is
         * subscribed — the alert most worth not losing, since a four-hour
         * freshness window exists precisely so opening the app after a large
         * event still announces it.
         */
        currentAlert(): Promise<EarthquakeEvent | null>;
        /** Clears main's retained alert, so `currentAlert` stops offering it. */
        dismissAlert(): Promise<void>;
        /** What arrived while the app was closed, or null. Fixed at launch. */
        missed(): Promise<MissedEvents | null>;
        /** What actually followed an event. Null if the id isn't catalogued. */
        sequence(eventId: string): Promise<AftershockSequence | null>;
        /** Observed recurrence intervals near a point, from this floor's epoch. */
        recurrence(request: {
          latitude: number;
          longitude: number;
          radiusKm: number;
          minMagnitude: number;
        }): Promise<RegionalRecurrence>;
        /** What was recorded near an event's antipode, plus the background rate. */
        antipodal(eventId: string): Promise<AntipodalWindow | null>;
      };
      aurora: {
        /** The latest grid, or null before the first successful poll. */
        latest(): Promise<AuroraGrid | null>;
        /** Subscribe to new grids; returns an unsubscribe function. */
        onUpdated(callback: (grid: AuroraGrid) => void): () => void;
      };
      tec: {
        /** The latest TEC map, or null if none could be fetched. */
        latest(): Promise<TecGrid | null>;
      };
      magnetometer: {
        /** The latest network read, empty before the first successful poll. */
        latest(): Promise<MagnetometerReading[]>;
        /** Subscribe to each refresh; returns an unsubscribe function. */
        onUpdated(callback: (readings: MagnetometerReading[]) => void): () => void;
      };
      spaceWeather: {
        /** Kp and Dst over a half-open range. Bounded on both ends. */
        query(request: { startUtc: string; endUtc: string }): Promise<SpaceWeatherSample[]>;
        status(): Promise<SpaceWeatherProgress>;
        /** Settles when the backfill finishes — follow onProgress instead. */
        start(): Promise<SpaceWeatherProgress>;
        cancel(): Promise<SpaceWeatherProgress>;
        onProgress(callback: (progress: SpaceWeatherProgress) => void): () => void;
        /** Fires when the rolling Kp poll stores something new. */
        onUpdated(callback: () => void): () => void;
      };
      archive: {
        status(): Promise<ArchiveProgress>;
        /** Settles when the whole backfill finishes — follow onProgress instead. */
        start(): Promise<ArchiveProgress>;
        cancel(): Promise<ArchiveProgress>;
        /** Subscribe to backfill progress; returns an unsubscribe function. */
        onProgress(callback: (progress: ArchiveProgress) => void): () => void;
      };
      solarEvents: {
        /** Flares peaking in a half-open range. Bounded on both ends. */
        queryFlares(request: { startUtc: string; endUtc: string }): Promise<SolarFlare[]>;
        /** CME arrivals in a half-open range. Bounded on both ends. */
        queryCmeArrivals(request: { startUtc: string; endUtc: string }): Promise<CmeArrival[]>;
        status(): Promise<DonkiProgress>;
        /** Settles when the whole backfill finishes — follow onProgress instead. */
        start(): Promise<DonkiProgress>;
        cancel(): Promise<DonkiProgress>;
        /** Never returns the key itself — only ever the resulting status. */
        saveApiKey(key: string): Promise<DonkiProgress>;
        /** Subscribe to backfill progress; returns an unsubscribe function. */
        onProgress(callback: (progress: DonkiProgress) => void): () => void;
        /** Fires when the live poll stores something new. */
        onUpdated(callback: () => void): () => void;
      };
      /**
       * The GOES XRS historical flare backfill (1996-2016). Its rows are read
       * through `solarEvents.queryFlares` like any other flare, so there is no
       * query channel here — only the download's own controls.
       */
      goesFlares: {
        status(): Promise<GoesFlareProgress>;
        /** Settles when the whole backfill finishes — follow onProgress instead. */
        start(): Promise<GoesFlareProgress>;
        cancel(): Promise<GoesFlareProgress>;
        /** Subscribe to backfill progress; returns an unsubscribe function. */
        onProgress(callback: (progress: GoesFlareProgress) => void): () => void;
      };
      /** Global CMT focal mechanisms — H6's fault orientations. */
      gcmt: {
        status(): Promise<GcmtProgress>;
        /** Settles when the whole backfill finishes — follow onProgress instead. */
        start(): Promise<GcmtProgress>;
        cancel(): Promise<GcmtProgress>;
        /** Subscribe to backfill progress; returns an unsubscribe function. */
        onProgress(callback: (progress: GcmtProgress) => void): () => void;
      };
      shell: {
        /** Resolves false if main refused to open the URL. */
        openExternal(url: string): Promise<boolean>;
      };
      analysis: {
        status(): Promise<EngineStatus>;
        hypotheses(): Promise<HypothesisSummary[]>;
        /** Sends only a hypothesis id — main assembles every registered parameter. */
        run(hypothesisId: HypothesisId): Promise<AnalysisRunOutcome>;
        /** Subscribe to engine process status changes; returns an unsubscribe function. */
        onEngineStatus(callback: (status: EngineStatus) => void): () => void;
      };
    };
  }
}
