'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Code2,
  Loader2,
  MessageSquare,
  PhoneOff,
  Send,
  Sparkles,
  Video,
  VideoOff,
} from 'lucide-react';
import { CodingChallenge, CodingPanel } from '@/components/interview/CodingPanel';
import { VoiceOrb } from '@/components/interview/VoiceOrb';
import { Alert, Badge, Button, Card, CardBody, Input } from '@/components/ui';
import { useAudioStreamer } from '@/hooks/useAudioStreamer';
import { useProctoring } from '@/hooks/useProctoring';
import { useListener, useSpeaker } from '@/hooks/useSpeech';
import { FrameMetrics, useVideoAnalysis } from '@/hooks/useVideoAnalysis';
import { API_BASE, api } from '@/lib/api';
import { cn, formatClock } from '@/lib/utils';
import type { DeviceChoice } from '@/components/interview/PreCheckScreen';

interface Props {
  token: string;
  devices: DeviceChoice;
  candidateName: string;
  interviewerName: string;
  sessionTitle: string;
  language: string;
  durationMinutes: number;
  videoAnalysisEnabled: boolean;
  recordingEnabled: boolean;
  onFinished: () => void;
}

type Phase = 'connecting' | 'greeting' | 'speaking' | 'listening' | 'thinking' | 'coding' | 'ended';

interface TranscriptLine {
  id: number;
  who: 'ai' | 'you';
  text: string;
}

const ROUND_LABELS: Record<string, string> = {
  GREETING: 'Getting started',
  IDENTITY: 'Identity check',
  INTRO: 'Introduction',
  HR: 'Behavioural round',
  TECHNICAL: 'Technical round',
  SCENARIO: 'Scenario round',
  PROJECT: 'Project deep-dive',
  CODING: 'Coding challenge',
  CLOSING: 'Wrapping up',
  DOUBT: 'Your question',
};

let lineId = 0;

export function LiveRoom({
  token,
  devices,
  candidateName,
  interviewerName,
  sessionTitle,
  language,
  durationMinutes,
  videoAnalysisEnabled,
  recordingEnabled,
  onFinished,
}: Props) {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [round, setRound] = useState('GREETING');
  const [progress, setProgress] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [challenge, setChallenge] = useState<CodingChallenge | null>(null);
  const [showCoding, setShowCoding] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [connectionError, setConnectionError] = useState('');
  const [typed, setTyped] = useState('');
  const [showTypeBox, setShowTypeBox] = useState(false);
  const [cameraOn, setCameraOn] = useState(devices.cameraEnabled);
  const [micLevel, setMicLevel] = useState(0);
  // Deepgram runs server-side; the browser recogniser is the fallback.
  const [useServerSpeech, setUseServerSpeech] = useState(true);
  const [serverInterim, setServerInterim] = useState('');
  const [endedReason, setEndedReason] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingMimeRef = useRef<string | null>(null);
  const chunkFailuresRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const endedRef = useRef(false);
  const [socketReady, setSocketReady] = useState<Socket | null>(null);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);

  const { speak, stop: stopSpeaking, speaking } = useSpeaker(language);

  const addLine = useCallback((who: 'ai' | 'you', text: string) => {
    setTranscript((prev) => [...prev, { id: lineId++, who, text }]);
  }, []);

  // --- Speech in --------------------------------------------------------

  const handleAnswer = useCallback(
    (result: { text: string; confidence: number; latencyMs: number; durationMs: number }) => {
      addLine('you', result.text);
      setPhase('thinking');
      listener.stop();

      socketRef.current?.emit('candidate_answer', {
        text: result.text,
        confidence: result.confidence,
        latencyMs: result.latencyMs,
        durationMs: result.durationMs,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addLine],
  );

  const listener = useListener({
    language,
    silenceMs: 3000,
    onFinal: handleAnswer,
    onSilenceTimeout: () => socketRef.current?.emit('silence_timeout'),
  });

  // --- Video analysis ---------------------------------------------------

  const postFrames = useCallback(
    (frames: FrameMetrics[]) => {
      // Metrics are best-effort; never interrupt the interview for them.
      void api.post(`/interview/${token}/video-metrics`, { frames }).catch(() => {});
    },
    [token],
  );

  const audioStreamer = useAudioStreamer({
    socket: socketReady,
    stream: micStream,
    // Runs for the whole interview; restarting it per turn corrupts the stream.
    enabled: useServerSpeech && phase !== 'connecting' && phase !== 'ended',
    // Only what the candidate says while the interviewer is waiting counts.
    accepting: phase === 'listening',
  });

  // Cannot truly prevent tab switching — no web page can — but it is noticed,
  // warned about, and recorded for the recruiter.
  const proctoring = useProctoring({
    socket: socketReady,
    active: phase !== 'connecting' && phase !== 'ended',
  });

  const { stats: videoStats } = useVideoAnalysis({
    videoRef,
    enabled: videoAnalysisEnabled && cameraOn && phase !== 'ended' && phase !== 'connecting',
    onBatch: postFrames,
  });

  // --- Media setup ------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: devices.audioDeviceId ? { deviceId: { exact: devices.audioDeviceId } } : true,
          video: devices.cameraEnabled
            ? devices.videoDeviceId
              ? { deviceId: { exact: devices.videoDeviceId } }
              : true
            : false,
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        setMicStream(stream);
        if (videoRef.current && devices.cameraEnabled) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        // Mic level meter for the candidate's own orb.
        const AudioCtx =
          window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        audioCtxRef.current = ctx;

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.8;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);

        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = ((data[i] ?? 128) - 128) / 128;
            sum += v * v;
          }
          setMicLevel(Math.min(1, Math.sqrt(sum / data.length) * 3.2));
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);

        // Recording is opportunistic — an unsupported codec must not break the room.
        if (recordingEnabled && typeof MediaRecorder !== 'undefined') {
          let recordStream = stream;

          if (devices.screenStream) {
            screenStreamRef.current = devices.screenStream;

            if (devices.cameraEnabled) {
              const canvas = document.createElement('canvas');
              canvas.width = 1280;
              canvas.height = 720;
              const ctx2d = canvas.getContext('2d');

              if (ctx2d) {
                const screenVideo = document.createElement('video');
                screenVideo.srcObject = devices.screenStream;
                screenVideo.muted = true;
                screenVideo.playsInline = true;
                await screenVideo.play().catch(() => {});

                const camVideo = document.createElement('video');
                camVideo.srcObject = stream;
                camVideo.muted = true;
                camVideo.playsInline = true;
                await camVideo.play().catch(() => {});

                const drawComposite = () => {
                  if (cancelled) return;
                  ctx2d.fillStyle = '#000';
                  ctx2d.fillRect(0, 0, canvas.width, canvas.height);
                  
                  // Draw screen full size
                  ctx2d.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
                  
                  // Draw camera PIP bottom right
                  const pipW = 320;
                  const pipH = 180;
                  const pad = 20;
                  ctx2d.drawImage(camVideo, canvas.width - pipW - pad, canvas.height - pipH - pad, pipW, pipH);
                  
                  rafRef.current = requestAnimationFrame(drawComposite);
                };
                rafRef.current = requestAnimationFrame(drawComposite);

                const canvasStream = canvas.captureStream(30);
                
                // Add mic audio track
                const audioTrack = stream.getAudioTracks()[0];
                if (audioTrack) {
                  canvasStream.addTrack(audioTrack);
                }
                recordStream = canvasStream;
              }
            } else {
               // Screen only, add mic audio
               const audioTrack = stream.getAudioTracks()[0];
               if (audioTrack) {
                 devices.screenStream.addTrack(audioTrack);
               }
               recordStream = devices.screenStream;
            }
          }

          const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
            .find((t) => MediaRecorder.isTypeSupported(t));

          if (mimeType) {
            const recorder = new MediaRecorder(recordStream, { mimeType, videoBitsPerSecond: 800_000 });

            // Each chunk is shipped as it is produced. Holding the whole
            // recording in memory until the end meant that closing the tab, or
            // any dropped connection, lost the entire session.
            recorder.ondataavailable = (e) => {
              if (e.data.size === 0) return;
              void uploadChunk(e.data);
            };

            recorder.start(5000);
            recorderRef.current = recorder;
            recordingMimeRef.current = mimeType;
          } else {
            console.warn('[recording] no supported MediaRecorder mime type; this session will not be recorded');
          }
        }
      } catch {
        if (!cancelled) {
          setConnectionError('Could not access your microphone. Please allow access and reload the page.');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      void audioCtxRef.current?.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Recording upload -------------------------------------------------

  /**
   * Ships one chunk. Failures are swallowed and retried implicitly by the next
   * chunk — a dropped segment is far better than interrupting the interview,
   * and the server keeps whatever did arrive.
   */
  const uploadChunk = useCallback(
    async (blob: Blob) => {
      const body = new FormData();
      body.append('chunk', blob, 'chunk.webm');

      try {
        await api.post(`/interview/${token}/recording/chunk`, body, {
          headers: { 'Content-Type': 'multipart/form-data' },
          timeout: 30_000,
        });
      } catch {
        chunkFailuresRef.current += 1;
        if (chunkFailuresRef.current === 3) {
          console.warn('[recording] several chunks failed to upload; the recording may be incomplete');
        }
      }
    },
    [token],
  );

  /** Flushes the recorder and asks the server to assemble the final file. */
  const finaliseRecording = useCallback(async () => {
    const recorder = recorderRef.current;

    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        // requestData forces the final partial chunk out before stopping.
        recorder.onstop = () => resolve();
        try {
          recorder.requestData();
        } catch {
          /* not all browsers allow this while recording */
        }
        recorder.stop();
      });

      // Give the last ondataavailable upload a moment to be issued.
      await new Promise((r) => setTimeout(r, 600));
    }

    await api
      .post(`/interview/${token}/recording/finalise`, {
        durationSeconds: elapsed,
        mimeType: recordingMimeRef.current ?? 'video/webm',
      })
      .catch(() => {
        // The server also finalises when the interview ends, so this is a
        // best-effort nudge rather than the only path.
      });
  }, [token, elapsed]);

  // --- Socket -----------------------------------------------------------

  useEffect(() => {
    const socket = io(`${API_BASE}/interview`, {
      query: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
    });
    socketRef.current = socket;

    setSocketReady(socket);
    socket.on('connect', () => setConnectionError(''));

    // --- Server-side transcription (Deepgram) ---------------------------
    socket.on('interim_transcript', (d: { text: string }) => setServerInterim(d.text));

    socket.on('final_transcript', (d: { text: string }) => {
      setServerInterim('');
      addLine('you', d.text);
      setPhase('thinking');
    });

    // Deepgram unavailable: fall back to the browser recogniser rather than
    // leaving the candidate unable to answer.
    socket.on('speech_unavailable', () => {
      console.warn('[speech] server transcription unavailable, using the browser instead');
      setUseServerSpeech(false);
    });

    // Wait for the server to confirm the room before announcing arrival, so a
    // reconnect never restarts an interview that is already under way.
    socket.on('connected', () => socket.emit('candidate_joined'));

    socket.on('connect_error', () => {
      setConnectionError('Lost connection to the interview server. Trying to reconnect…');
    });

    socket.on('error_message', (data: { message: string }) => setConnectionError(data.message));

    socket.on('interview_closed', () => {
      endedRef.current = true;
      setPhase('ended');
      onFinished();
    });

    socket.on('ai_thinking', (data: { active: boolean }) => {
      if (data.active) setPhase('thinking');
    });

    socket.on('state_change', (data: { state: string; round?: string; progress: number }) => {
      if (data.round) setRound(data.round);
      setProgress(data.progress);
    });

    socket.on('coding_challenge', (data: { question: CodingChallenge }) => {
      setChallenge(data.question);
      setShowCoding(true);
    });

    // The AI speaks, then hands the floor back to the candidate.
    socket.on('ai_speak', async (data: { text: string; expectsAnswer: boolean; round?: string }) => {
      if (endedRef.current) return;

      if (data.round) setRound(data.round);
      addLine('ai', data.text);

      setPhase('speaking');
      listener.stop();
      setServerInterim('');

      await speak(data.text);

      if (endedRef.current) return;

      if (data.expectsAnswer) {
        setPhase('listening');
        // The audio streamer starts itself via the `phase` dependency; the
        // browser recogniser only runs when Deepgram is not handling it.
        if (!useServerSpeech) listener.start();
      } else {
        setPhase('thinking');
      }
    });

    socket.on('interview_ended', (data: { reason?: string }) => {
      endedRef.current = true;
      setEndedReason(data?.reason ?? null);
      listener.stop();
      stopSpeaking();
      setPhase('ended');
      void finaliseRecording().finally(onFinished);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // --- Timers and scrolling ---------------------------------------------

  useEffect(() => {
    if (phase === 'connecting' || phase === 'ended') return;
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [transcript]);

  // Warn before an accidental refresh mid-interview.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (phase !== 'ended' && phase !== 'connecting') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [phase]);

  useEffect(() => {
    if (phase === 'connecting' && socketRef.current?.connected) setPhase('greeting');
  }, [phase]);

  // Start the browser recogniser if server transcription fails mid-turn.
  useEffect(() => {
    if (!useServerSpeech && phase === 'listening' && !listener.listening) {
      listener.start();
    }
  }, [useServerSpeech, phase, listener]);

  // --- Actions ----------------------------------------------------------

  const sendTyped = () => {
    const text = typed.trim();
    if (!text) return;

    addLine('you', text);
    setTyped('');
    setPhase('thinking');
    listener.stop();

    socketRef.current?.emit('candidate_answer', { text, confidence: 1 });
  };

  const askDoubt = () => {
    const text = typed.trim();
    if (!text) return;
    setTyped('');
    listener.stop();
    setPhase('thinking');
    socketRef.current?.emit('candidate_doubt', { text });
  };

  const endInterview = async () => {
    if (!confirm('End the interview now? Your answers so far will still be evaluated.')) return;

    endedRef.current = true;
    listener.stop();
    stopSpeaking();
    setPhase('ended');
    socketRef.current?.emit('end_interview');
    await finaliseRecording();
    onFinished();
  };

  const toggleCamera = () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
  };

  const onCodingSubmitted = (summary: { passed: number; total: number }) => {
    socketRef.current?.emit('coding_submitted', summary);
    setShowCoding(false);
  };

  // --- Render -----------------------------------------------------------

  const phaseLabel: Record<Phase, string> = {
    connecting: 'Connecting…',
    greeting: 'Starting…',
    speaking: `${interviewerName} is speaking`,
    listening: 'Listening — speak when ready',
    thinking: `${interviewerName} is thinking…`,
    coding: 'Coding challenge',
    ended: 'Interview complete',
  };

  const isListening = useServerSpeech ? phase === 'listening' && audioStreamer.streaming : listener.listening;
  const interim = useServerSpeech ? serverInterim : listener.interim;
  const overTime = elapsed > durationMinutes * 60;

  return (
    <div className="flex h-dscreen flex-col overflow-hidden bg-background">
      {/* Header */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-2 w-2 shrink-0">
            {phase !== 'ended' && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
            )}
            <span
              className={cn('relative inline-flex h-2 w-2 rounded-full', phase === 'ended' ? 'bg-muted-foreground' : 'bg-success')}
            />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{sessionTitle}</p>
            <p className="truncate text-xs text-muted-foreground">{phaseLabel[phase]}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge tone="primary">{ROUND_LABELS[round] ?? round}</Badge>
          <span className={cn('font-mono text-sm tabular-nums', overTime ? 'text-warning' : 'text-muted-foreground')}>
            {formatClock(elapsed)}
          </span>
        </div>
      </header>

      {/* Progress */}
      <div className="h-0.5 shrink-0 bg-muted">
        <div className="h-full bg-primary transition-all duration-500" style={{ width: `${progress}%` }} />
      </div>

      {connectionError && (
        <div className="shrink-0 px-4 pt-3">
          <Alert tone="danger">{connectionError}</Alert>
        </div>
      )}

      {proctoring.warning && (
        <div className="shrink-0 px-3 pt-3 sm:px-4">
          <Alert tone="warning" title="Stay on this tab">
            {proctoring.warning}
          </Alert>
        </div>
      )}

      {/* Body */}
      {showCoding && challenge ? (
        <div className="min-h-0 flex-1 p-3 sm:p-4">
          <CodingPanel token={token} challenge={challenge} onSubmitted={onCodingSubmitted} />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-3 sm:p-4 lg:grid-cols-[1fr_22rem] lg:overflow-hidden">
          {/* Stage */}
          <div className="flex min-h-0 flex-col items-center justify-center gap-6 py-4 sm:gap-8">
            <div className="flex items-center gap-8 sm:gap-16 lg:gap-20">
              <VoiceOrb
                role="interviewer"
                active={speaking}
                level={speaking ? 0.5 : 0}
                label={interviewerName}
                sublabel={speaking ? 'Speaking' : phase === 'thinking' ? 'Thinking' : 'Listening'}
              />
              <VoiceOrb
                role="candidate"
                active={isListening && micLevel > 0.05}
                level={micLevel}
                label={candidateName.split(' ')[0] ?? 'You'}
                sublabel={isListening ? 'Your turn' : 'Muted'}
              />
            </div>

            {/* What we're hearing right now */}
            <div className="min-h-[3.5rem] w-full max-w-xl text-center">
              {interim ? (
                <p className="text-sm italic text-muted-foreground">{interim}</p>
              ) : phase === 'thinking' ? (
                <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Considering your answer
                </p>
              ) : phase === 'listening' ? (
                <p className="text-sm text-muted-foreground">Take your time. Pause when you have finished answering.</p>
              ) : null}
            </div>

            {!useServerSpeech && listener.error && (
              <Alert tone="warning" className="max-w-xl">
                {listener.error}
              </Alert>
            )}

            {/* Controls */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {!useServerSpeech && listener.listening && (
                <Button variant="outline" onClick={listener.submitNow}>
                  <Send className="h-4 w-4" />
                  I&apos;m done answering
                </Button>
              )}

              <Button variant="outline" onClick={() => setShowTypeBox((v) => !v)}>
                <MessageSquare className="h-4 w-4" />
                Type instead
              </Button>

              {devices.cameraEnabled && (
                <Button variant="outline" size="icon" onClick={toggleCamera} title={cameraOn ? 'Turn camera off' : 'Turn camera on'}>
                  {cameraOn ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
                </Button>
              )}

              {challenge && !showCoding && (
                <Button variant="outline" onClick={() => setShowCoding(true)}>
                  <Code2 className="h-4 w-4" />
                  Open editor
                </Button>
              )}

              <Button variant="danger" onClick={endInterview}>
                <PhoneOff className="h-4 w-4" />
                End
              </Button>
            </div>

            {showTypeBox && (
              <div className="w-full max-w-xl space-y-2">
                <div className="flex gap-2">
                  <Input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendTyped()}
                    placeholder="Type your answer, or a question for the interviewer"
                    autoFocus
                  />
                  <Button onClick={sendTyped} disabled={!typed.trim()}>
                    <Send className="h-4 w-4" />
                    Answer
                  </Button>
                </div>
                <button
                  onClick={askDoubt}
                  disabled={!typed.trim()}
                  className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                >
                  Ask this as a clarifying question instead
                </button>
              </div>
            )}
          </div>

          {/* Side rail */}
          <div className="flex min-h-0 flex-col gap-3">
            {devices.cameraEnabled && (
              <Card className="shrink-0 overflow-hidden">
                <div className="relative aspect-video bg-foreground/90">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className={cn('h-full w-full object-cover', !cameraOn && 'hidden')}
                    style={{ transform: 'scaleX(-1)' }}
                  />
                  {!cameraOn && (
                    <div className="flex h-full items-center justify-center text-white/50">
                      <VideoOff className="h-6 w-6" />
                    </div>
                  )}
                </div>

                {videoAnalysisEnabled && cameraOn && (
                  <CardBody className="py-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">On camera</span>
                      <span className={cn('font-medium', videoStats.facePresent ? 'text-success' : 'text-warning')}>
                        {videoStats.facePresent ? (videoStats.centred ? 'Centred' : 'Off-centre') : 'Not detected'}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-500"
                        style={{ width: `${Math.round(videoStats.confidence * 100)}%` }}
                      />
                    </div>
                  </CardBody>
                )}
              </Card>
            )}

            {/* Transcript */}
            <Card className="flex min-h-[16rem] flex-1 flex-col overflow-hidden lg:min-h-0">
              <div className="shrink-0 border-b border-border px-4 py-2.5">
                <h3 className="text-sm font-semibold">Conversation</h3>
              </div>

              <div className="scroll-area flex-1 space-y-3 p-3.5">
                {transcript.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    The conversation will appear here.
                  </p>
                ) : (
                  transcript.map((line) => (
                    <div key={line.id} className={cn('flex', line.who === 'you' && 'justify-end')}>
                      <div
                        className={cn(
                          'max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed',
                          line.who === 'ai'
                            ? 'rounded-tl-sm bg-muted text-foreground'
                            : 'rounded-tr-sm bg-primary text-primary-foreground',
                        )}
                      >
                        {line.text}
                      </div>
                    </div>
                  ))
                )}
                <div ref={transcriptEndRef} />
              </div>
            </Card>
          </div>
        </div>
      )}

      {phase === 'ended' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4">
          <Card className="w-full max-w-md">
            <CardBody className="text-center">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-success-soft">
                <Sparkles className="h-5 w-5 text-success" />
              </div>
              <h2 className="mt-4 text-lg font-semibold">
                {endedReason === 'abandoned' ? 'Interview ended early' : 'Interview complete'}
              </h2>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {endedReason === 'abandoned'
                  ? `This interview was ended before ${interviewerName} finished, so it has been recorded as incomplete. Please contact the recruiter if you would like to be rescheduled.`
                  : `Thank you for your time, ${candidateName.split(' ')[0]}. Your responses are being evaluated and the hiring team will be in touch.`}
              </p>
              <p className="mt-3 text-xs text-muted-foreground">You can close this window.</p>
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
