import { useEffect, useState } from 'react';
import {
  WAVEFORM_WINDOW_MS,
  type WaveformChannel,
  type WaveformStreamStatus,
} from '@terra-pulse/schema';
import { EMPTY_CHANNEL_BUFFER, appendSegment, type ChannelBuffer } from './waveform-buffer';

export interface WaveformStream {
  /** Null until the first status arrives. */
  status: WaveformStreamStatus | null;
  buffers: ReadonlyMap<string, ChannelBuffer>;
  /** A `start` main refused — a bad request, not a dropped connection. */
  error: string | null;
}

/** Held against the channel list it describes; see the note in the hook. */
interface KeyedStream extends WaveformStream {
  key: readonly WaveformChannel[] | null;
}

const NOTHING: WaveformStream = { status: null, buffers: new Map(), error: null };

/**
 * Opens the stream for `channels` while this component is mounted, and keeps a
 * rolling buffer of what arrives.
 *
 * **`channels` must be a stable reference.** It is the effect's dependency, so
 * a fresh array each render would tear the connection down and rebuild it on
 * every render. Callers derive it from the region and memoise on the region id.
 *
 * **State is stored against the channel list it describes**, the same shape
 * `useMagnetometerSeries` uses. That makes one region's traces under another
 * region's headings *unrenderable* rather than merely unlikely — switching
 * region fires overlapping work with no ordering guarantee, and a segment from
 * the outgoing stream must never land in the incoming one's buffer. It also
 * means nothing has to be cleared when the region changes: the old state simply
 * stops matching, which is what keeps this hook free of a `setState` in the
 * effect body. React's own lint rule rejects that pattern, and it is right —
 * the keyed version is better than the one it refused.
 *
 * Subscriptions are attached **before** `start`, and the current status is
 * pulled once afterwards — the two-step `useAurora` uses. Subscribing first
 * closes the window where a push could arrive before anyone is listening;
 * pulling afterwards covers a state that changed before we subscribed.
 *
 * Under React StrictMode this effect runs twice in development, which is
 * start → stop → start inside one tick. That is exactly the case the
 * controller's generation counters exist for, and it is worth leaving as a
 * live exercise of them rather than suppressing.
 */
export function useWaveformStream(channels: readonly WaveformChannel[]): WaveformStream {
  const [state, setState] = useState<KeyedStream>({ key: null, ...NOTHING });

  useEffect(() => {
    let live = true;

    /** Folds an update into the state for *these* channels, and no others. */
    const update = (change: (previous: WaveformStream) => WaveformStream) => {
      if (!live) return;
      setState((previous) => {
        const base = previous.key === channels ? previous : { key: channels, ...NOTHING };
        return { key: channels, ...change(base) };
      });
    };

    const offSegment = window.terraPulse.waveforms.onSegment((segment) => {
      update((previous) => {
        const buffers = new Map(previous.buffers);
        buffers.set(
          segment.channelId,
          appendSegment(
            previous.buffers.get(segment.channelId) ?? EMPTY_CHANNEL_BUFFER,
            segment,
            WAVEFORM_WINDOW_MS,
          ),
        );
        return { ...previous, buffers };
      });
    });

    const offStatus = window.terraPulse.waveforms.onStatus((status) => {
      update((previous) => ({ ...previous, status }));
    });

    window.terraPulse.waveforms.start(channels).then(
      (status) => {
        update((previous) => ({ ...previous, status }));
      },
      (cause: unknown) => {
        // A refused request is a bug in what we asked for, not a transport
        // failure, so it is surfaced rather than retried.
        update((previous) => ({
          ...previous,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
      },
    );

    return () => {
      live = false;
      offSegment();
      offStatus();
      void window.terraPulse.waveforms.stop();
    };
  }, [channels]);

  return state.key === channels ? state : NOTHING;
}
