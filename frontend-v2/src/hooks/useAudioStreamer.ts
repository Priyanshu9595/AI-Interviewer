'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

/**
 * Streams microphone audio to our own server, which relays it to Deepgram.
 *
 * The transcription key stays server-side — a browser-held key is trivially
 * extractable from the network tab. The server sends interim and final
 * transcripts back over the same interview socket.
 */
export function useAudioStreamer({
  socket,
  stream,
  enabled,
}: {
  socket: Socket | null;
  stream: MediaStream | null;
  enabled: boolean;
}) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [supported, setSupported] = useState(true);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;

    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        /* already stopping */
      }
    }
    setStreaming(false);
  }, []);

  const start = useCallback(() => {
    if (!socket || !stream || recorderRef.current) return;

    if (typeof MediaRecorder === 'undefined') {
      setSupported(false);
      return;
    }

    // Deepgram accepts Opus in a WebM container directly.
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );

    if (!mimeType) {
      setSupported(false);
      return;
    }

    // Audio only: the recorder for the saved video is a separate instance.
    const audioOnly = new MediaStream(stream.getAudioTracks());
    const recorder = new MediaRecorder(audioOnly, { mimeType, audioBitsPerSecond: 32_000 });

    recorder.ondataavailable = async (e) => {
      if (e.data.size === 0 || !socket.connected) return;
      socket.emit('audio_chunk', await e.data.arrayBuffer());
    };

    // 250ms keeps transcription responsive without flooding the socket.
    recorder.start(250);
    recorderRef.current = recorder;
    setStreaming(true);

    socket.emit('turn_started');
  }, [socket, stream]);

  useEffect(() => {
    if (enabled) start();
    else stop();
  }, [enabled, start, stop]);

  useEffect(() => stop, [stop]);

  /** Tells the server a fresh answer is beginning, so latency stays accurate. */
  const markTurnStart = useCallback(() => socket?.emit('turn_started'), [socket]);

  return { streaming, supported, start, stop, markTurnStart };
}
