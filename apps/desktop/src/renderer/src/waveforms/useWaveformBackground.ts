import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WaveformChannel } from '@terra-pulse/schema';
import { channelsOf } from './waveform-regions';
import { useWaveformStore } from './useWaveformStore';
import { useWaveformSelection } from './useWaveformSelection';
import type { WaveformSelection } from './waveform-selection';
import { useWaveformStream, type WaveformStream } from './useWaveformStream';

const NO_CHANNELS: readonly WaveformChannel[] = [];

/**
 * Pulls the picker's station list once the stream has been asked for.
 *
 * Every call asks, and main answers from its own hour-long cache, so this is a
 * ~300 KB clone rather than a fetch. Asking each time is what lets a failed
 * list recover by leaving Explore and coming back — and the Retry button does
 * the same thing without the detour. Nothing is fetched before `enabled`, so a
 * launch costs nothing.
 */
function useStationCatalogue(enabled: boolean): () => void {
  const setCatalogue = useWaveformStore((state) => state.setCatalogue);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    window.terraPulse.waveforms.stations().then(
      (catalogue) => {
        if (live) setCatalogue(catalogue);
      },
      (cause: unknown) => {
        if (!live) return;
        setCatalogue({
          status: 'unavailable',
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      },
    );
    return () => {
      live = false;
    };
  }, [enabled, setCatalogue, attempt]);

  return useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);
}

export interface WaveformBackground {
  selection: WaveformSelection | null;
  /** The channels being streamed — empty before the stream is first asked for. */
  channels: readonly WaveformChannel[];
  stream: WaveformStream;
  retryCatalogue: () => void;
}

/**
 * The live stream, kept running whether or not its panel is on screen.
 *
 * Owned by the dock rather than by the waveform panel, so minimising the dock
 * or switching to the timeline keeps the buffers filling: reopening shows the
 * last two minutes at once instead of an empty panel starting over. Nothing
 * starts until `started` — the dock's latch, set the first time the waveform
 * tab is shown — so a launch opens no socket.
 *
 * The stream still stops when Explore unmounts (Analyze is selected), because
 * the dock goes with it; the latch survives in the store, so coming back
 * restarts it.
 */
export function useWaveformBackground(started: boolean): WaveformBackground {
  const selection = useWaveformSelection();
  const retryCatalogue = useStationCatalogue(started);

  /**
   * The channels to stream, **keyed on their ids rather than on an array**.
   *
   * This list is the stream effect's dependency, so a new identity tears the
   * connection down and rebuilds it. The station list landing ~3 s after the
   * first open, or an hourly refresh of it, re-runs the selection and hands out
   * new arrays for the very same stations — keying on content means only a real
   * change of stations restarts the stream.
   */
  const channelKey = started ? JSON.stringify(channelsOf(selection?.stations ?? [])) : '';
  const channels = useMemo(
    () => (channelKey === '' ? NO_CHANNELS : (JSON.parse(channelKey) as WaveformChannel[])),
    [channelKey],
  );
  const stream = useWaveformStream(channels);

  return { selection, channels, stream, retryCatalogue };
}
