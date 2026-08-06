'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// The Web Speech API is not in the standard DOM typings.
interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const speechSupported = () => getRecognitionCtor() !== null;

// ---------------------------------------------------------------------------
// Speaking (text to speech)
// ---------------------------------------------------------------------------

export function useSpeaker(language: string) {
  const [speaking, setSpeaking] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const resolveRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;

    // Voices load asynchronously in most browsers.
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);

    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', load);
      window.speechSynthesis.cancel();
    };
  }, []);

  const pickVoice = useCallback(() => {
    if (!voices.length) return null;

    const exact = voices.find((v) => v.lang === language);
    if (exact) return exact;

    // Fall back to any voice sharing the base language ("en" from "en-IN").
    const base = language.split('-')[0];
    return voices.find((v) => v.lang.startsWith(`${base}`)) ?? null;
  }, [voices, language]);

  /** Speaks the text and resolves once playback finishes. */
  const speak = useCallback(
    (text: string): Promise<void> =>
      new Promise((resolve) => {
        if (typeof window === 'undefined' || !window.speechSynthesis || !text.trim()) {
          return resolve();
        }

        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = language;
        utterance.rate = 1.0;
        utterance.pitch = 1.0;

        const voice = pickVoice();
        if (voice) utterance.voice = voice;

        const finish = () => {
          setSpeaking(false);
          resolveRef.current = null;
          resolve();
        };

        utterance.onend = finish;
        utterance.onerror = finish;
        resolveRef.current = finish;

        setSpeaking(true);
        window.speechSynthesis.speak(utterance);

        // Chrome silently drops long utterances; a watchdog keeps the flow alive.
        const watchdogMs = Math.max(5000, text.length * 90);
        setTimeout(() => {
          if (resolveRef.current === finish) {
            window.speechSynthesis.cancel();
            finish();
          }
        }, watchdogMs);
      }),
    [language, pickVoice],
  );

  const stop = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
    resolveRef.current?.();
    setSpeaking(false);
  }, []);

  return { speak, stop, speaking, voiceAvailable: voices.length > 0 };
}

// ---------------------------------------------------------------------------
// Listening (speech to text)
// ---------------------------------------------------------------------------

export interface FinalTranscript {
  text: string;
  confidence: number;
  /** Milliseconds from the start of listening to the first word. */
  latencyMs: number;
  /** Milliseconds spent speaking. */
  durationMs: number;
}

/**
 * Wraps the browser recogniser in an interview-shaped loop: it listens, watches
 * for the candidate to stop speaking, and reports one complete answer.
 *
 * Browsers end recognition on their own after a pause, so `continuous` alone is
 * not enough — a silence timer decides when the answer is actually finished.
 */
export function useListener({
  language,
  silenceMs = 2500,
  onFinal,
  onSilenceTimeout,
}: {
  language: string;
  silenceMs?: number;
  onFinal: (result: FinalTranscript) => void;
  onSilenceTimeout?: () => void;
}) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalTextRef = useRef('');
  const confidenceRef = useRef<number[]>([]);
  const startedAtRef = useRef(0);
  const firstWordAtRef = useRef(0);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const noSpeechTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Distinguishes a deliberate stop from the browser ending the session itself.
  const wantsToListenRef = useRef(false);

  const onFinalRef = useRef(onFinal);
  const onSilenceRef = useRef(onSilenceTimeout);
  useEffect(() => {
    onFinalRef.current = onFinal;
    onSilenceRef.current = onSilenceTimeout;
  }, [onFinal, onSilenceTimeout]);

  const clearTimers = () => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (noSpeechTimerRef.current) clearTimeout(noSpeechTimerRef.current);
    silenceTimerRef.current = null;
    noSpeechTimerRef.current = null;
  };

  /** Publishes whatever has been captured as one finished answer. */
  const commit = useCallback(() => {
    const text = finalTextRef.current.trim();
    if (!text) return;

    const now = Date.now();
    const scores = confidenceRef.current.filter((c) => c > 0);

    onFinalRef.current({
      text,
      confidence: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.85,
      latencyMs: Math.max(0, (firstWordAtRef.current || now) - startedAtRef.current),
      durationMs: Math.max(0, now - (firstWordAtRef.current || now)),
    });

    finalTextRef.current = '';
    confidenceRef.current = [];
    firstWordAtRef.current = 0;
    setInterim('');
  }, []);

  const stop = useCallback(() => {
    wantsToListenRef.current = false;
    clearTimers();

    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
    }

    setListening(false);
    setInterim('');
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('This browser cannot transcribe speech. Use Chrome or Edge, or type your answers.');
      return;
    }

    // Never stack two recognisers.
    if (recognitionRef.current) stop();

    const recognition = new Ctor();
    recognition.lang = language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    finalTextRef.current = '';
    confidenceRef.current = [];
    firstWordAtRef.current = 0;
    startedAtRef.current = Date.now();
    wantsToListenRef.current = true;
    setError(null);

    recognition.onstart = () => setListening(true);

    recognition.onresult = (event) => {
      clearTimers();

      let interimText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;

        const alt = result[0];
        if (!alt) continue;

        if (!firstWordAtRef.current) firstWordAtRef.current = Date.now();

        if (result.isFinal) {
          finalTextRef.current = `${finalTextRef.current} ${alt.transcript}`.trim();
          confidenceRef.current.push(alt.confidence);
        } else {
          interimText += alt.transcript;
        }
      }

      setInterim(interimText);

      // The candidate has paused long enough that the answer is complete.
      silenceTimerRef.current = setTimeout(() => {
        if (finalTextRef.current.trim()) commit();
      }, silenceMs);
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;

      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setError('Microphone access was denied. Allow it in your browser, or type your answers instead.');
        wantsToListenRef.current = false;
        setListening(false);
        return;
      }

      if (event.error === 'network') {
        setError('Speech recognition lost its network connection. You can type your answers instead.');
      }
    };

    recognition.onend = () => {
      setListening(false);

      // Browsers end the session on their own; restart if we still want to hear.
      if (wantsToListenRef.current) {
        if (finalTextRef.current.trim()) {
          commit();
        }
        try {
          recognition.start();
        } catch {
          /* start() throws when already starting; the next onend retries */
        }
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch {
      setError('Could not start the microphone. Please refresh and try again.');
    }

    // Nothing at all after a long wait means the candidate has gone quiet.
    noSpeechTimerRef.current = setTimeout(() => {
      if (!finalTextRef.current.trim() && !firstWordAtRef.current) onSilenceRef.current?.();
    }, 20_000);
  }, [language, silenceMs, commit, stop]);

  /** Ends the turn immediately, e.g. when the candidate presses "Done". */
  const submitNow = useCallback(() => {
    clearTimers();
    commit();
  }, [commit]);

  useEffect(() => stop, [stop]);

  return { start, stop, submitNow, listening, interim, error, supported: speechSupported() };
}
