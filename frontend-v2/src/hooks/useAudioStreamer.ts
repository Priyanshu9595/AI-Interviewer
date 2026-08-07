'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

/**
 * Streams microphone audio to our own server, which relays it to Deepgram.
 *
 * The recorder runs **continuously** for the whole interview and is never
 * restarted between turns. MediaRecorder emits a WebM container header on its
 * first chunk only, so stopping and starting it mid-session pushes a second
 * header into a stream Deepgram is already parsing — after which it stops
 * returning transcripts entirely. Whether the candidate's speech counts as an
 * answer is decided by the server, not by muting the microphone.
 *
 * The transcription key stays server-side; a browser-held key is trivially
 * lifted from the network tab.
 */
export function useAudioStreamer({
  socket,
  stream,
  enabled,
  /** True only while the interviewer is waiting for an answer. */
  accepting,
}: {
  socket: Socket | null;
  stream: MediaStream | null;
  enabled: boolean;
  accepting: boolean;
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

  // One recorder for the whole interview.
  useEffect(() => {
    if (!enabled || !socket || !stream || recorderRef.current) return;

    if (typeof MediaRecorder === 'undefined') {
      setSupported(false);
      return;
    }

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );

    if (!mimeType) {
      setSupported(false);
      return;
    }

    // Audio only: the video recording uses its own recorder instance.
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

    return () => {
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          /* already stopping */
        }
      }
      recorderRef.current = null;
      setStreaming(false);
    };
  }, [enabled, socket, stream]);

  /**
   * Tells the server whether what it hears should be treated as an answer.
   * Gating here rather than by stopping the recorder keeps the audio stream
   * intact and stops the interviewer's own voice being transcribed as a reply.
   */
  useEffect(() => {
    if (!socket?.connected) return;
    socket.emit(accepting ? 'listening_started' : 'listening_stopped');
  }, [socket, accepting]);

  useEffect(() => stop, [stop]);

  return { streaming, supported, stop };
}
