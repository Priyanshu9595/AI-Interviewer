'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Camera, CameraOff, CheckCircle2, Mic, Video } from 'lucide-react';
import { ResumeUpload } from '@/components/interview/ResumeUpload';
import { Alert, Button, Card, CardBody, Field, Select } from '@/components/ui';
import { speechSupported } from '@/hooks/useSpeech';
import { cn } from '@/lib/utils';

export interface DeviceChoice {
  audioDeviceId: string;
  videoDeviceId: string;
  cameraEnabled: boolean;
}

interface Props {
  candidateName: string;
  sessionTitle: string;
  interviewerName: string;
  durationMinutes: number;
  videoRequired: boolean;
  /** Candidate access token, used for the optional resume upload. */
  token: string;
  onReady: (choice: DeviceChoice) => void;
}

export function PreCheckScreen({
  candidateName,
  sessionTitle,
  interviewerName,
  durationMinutes,
  videoRequired,
  token,
  onReady,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioId, setAudioId] = useState('');
  const [videoId, setVideoId] = useState('');
  const [cameraEnabled, setCameraEnabled] = useState(videoRequired);
  const [level, setLevel] = useState(0);
  const [heardSound, setHeardSound] = useState(false);
  const [micError, setMicError] = useState('');
  const [camError, setCamError] = useState('');
  const [starting, setStarting] = useState(false);

  const teardown = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  const openStream = useCallback(
    async (audioDeviceId?: string, videoDeviceId?: string, withCamera = cameraEnabled) => {
      teardown();
      setMicError('');
      setCamError('');

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: audioDeviceId ? { 
            deviceId: { exact: audioDeviceId },
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true
          } : {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true
          },
          video: withCamera ? (videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true) : false,
        });

        streamRef.current = stream;

        if (withCamera && videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        // Labels are only populated after permission is granted.
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter((d) => d.kind === 'audioinput');
        const cams = devices.filter((d) => d.kind === 'videoinput');
        setAudioDevices(mics);
        setVideoDevices(cams);
        if (!audioDeviceId && mics[0]) setAudioId(mics[0].deviceId);
        if (!videoDeviceId && cams[0]) setVideoId(cams[0].deviceId);

        // Live input meter so the candidate can confirm the mic works.
        const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        audioCtxRef.current = ctx;

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.75;
        ctx.createMediaStreamSource(stream).connect(analyser);

        const data = new Uint8Array(analyser.fftSize);

        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = ((data[i] ?? 128) - 128) / 128;
            sum += v * v;
          }
          const rms = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
          setLevel(rms);
          if (rms > 0.08) setHeardSound(true);
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        const name = (err as DOMException).name;
        const message =
          name === 'NotAllowedError'
            ? 'Permission was denied. Allow access from the icon in your browser address bar, then reload.'
            : name === 'NotFoundError'
              ? 'No device was found.'
              : 'Could not open the device.';

        if (withCamera) {
          setCamError(message);
          // Fall back to audio only so a missing camera never blocks the interview.
          if (name === 'NotFoundError' || name === 'NotReadableError') {
            setCameraEnabled(false);
            void openStream(audioDeviceId, undefined, false);
            return;
          }
        }
        setMicError(message);
      }
    },
    [cameraEnabled, teardown],
  );

  useEffect(() => {
    void openStream();
    return teardown;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    setStarting(true);
    teardown();
    onReady({ audioDeviceId: audioId, videoDeviceId: videoId, cameraEnabled });
  };

  const micReady = !micError && streamRef.current !== null;
  const transcriptionSupported = speechSupported();

  return (
    <div className="flex min-h-dscreen items-start justify-center bg-background px-3 py-6 sm:items-center sm:px-4 sm:py-10">
      <div className="w-full max-w-3xl">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Ready when you are, {candidateName.split(' ')[0]}</h1>
          <p className="mt-1.5 text-muted-foreground">
            {sessionTitle} · about {durationMinutes} minutes with {interviewerName}
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-5">
          {/* Camera preview */}
          <Card className="overflow-hidden lg:col-span-3">
            <div className="relative aspect-video bg-foreground/90">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={cn('h-full w-full object-cover', !cameraEnabled && 'hidden')}
                // Mirror, so it reads like a mirror rather than a video call of yourself.
                style={{ transform: 'scaleX(-1)' }}
              />
              {!cameraEnabled && (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-white/60">
                  <CameraOff className="h-7 w-7" />
                  <p className="text-sm">Camera is off</p>
                </div>
              )}
            </div>

            <CardBody className="space-y-3">
              <button
                type="button"
                onClick={() => {
                  const next = !cameraEnabled;
                  setCameraEnabled(next);
                  void openStream(audioId, videoId, next);
                }}
                className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-muted"
              >
                <span className="flex items-center gap-2">
                  <Camera className="h-4 w-4 text-muted-foreground" />
                  Camera
                </span>
                <span className={cn('font-medium', cameraEnabled ? 'text-success' : 'text-muted-foreground')}>
                  {cameraEnabled ? 'On' : 'Off'}
                </span>
              </button>

              {cameraEnabled && videoDevices.length > 1 && (
                <Field label="Camera device">
                  <Select
                    value={videoId}
                    onChange={(e) => {
                      setVideoId(e.target.value);
                      void openStream(audioId, e.target.value, true);
                    }}
                  >
                    {videoDevices.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Camera ${i + 1}`}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}

              {camError && cameraEnabled && <Alert tone="warning">{camError}</Alert>}
            </CardBody>
          </Card>

          {/* Mic check */}
          <Card className="lg:col-span-2">
            <CardBody className="space-y-4">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <Mic className="h-4 w-4 text-muted-foreground" />
                  Microphone check
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Say something out loud. The bars should move.
                </p>
              </div>

              {micError ? (
                <Alert tone="danger" title="Microphone unavailable">
                  {micError}
                </Alert>
              ) : (
                <>
                  <div className="flex h-11 items-center gap-[3px] rounded-md border border-border bg-muted/50 px-2.5">
                    {Array.from({ length: 22 }).map((_, i) => {
                      const active = level * 22 > i;
                      return (
                        <div
                          key={i}
                          className={cn(
                            'flex-1 rounded-sm transition-all duration-75',
                            active ? (i > 17 ? 'bg-warning' : 'bg-success') : 'bg-border',
                          )}
                          style={{ height: active ? `${25 + (i / 22) * 55}%` : '18%' }}
                        />
                      );
                    })}
                  </div>

                  <div
                    className={cn(
                      'flex items-center gap-2 text-sm',
                      heardSound ? 'text-success' : 'text-muted-foreground',
                    )}
                  >
                    {heardSound ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                    {heardSound ? 'We can hear you clearly' : 'Waiting to hear you…'}
                  </div>

                  {audioDevices.length > 1 && (
                    <Field label="Microphone device">
                      <Select
                        value={audioId}
                        onChange={(e) => {
                          setAudioId(e.target.value);
                          setHeardSound(false);
                          void openStream(e.target.value, videoId, cameraEnabled);
                        }}
                      >
                        {audioDevices.map((d, i) => (
                          <option key={d.deviceId} value={d.deviceId}>
                            {d.label || `Microphone ${i + 1}`}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                </>
              )}
            </CardBody>
          </Card>
        </div>

        {!transcriptionSupported && (
          <Alert tone="warning" title="This browser cannot transcribe speech" className="mt-4">
            The interview will still run, but you will need to type your answers. For the full spoken experience, open
            this link in Chrome or Edge.
          </Alert>
        )}

        <div className="mt-4">
          <ResumeUpload token={token} />
        </div>

        <Card className="mt-4">
          <CardBody>
            <h3 className="text-sm font-semibold">Before you begin</h3>
            <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              <li>· Find a quiet room with a stable internet connection.</li>
              <li>· Speak naturally. The interviewer waits for you to finish before responding.</li>
              <li>· If you need something repeated or clarified, just ask.</li>
              <li>· Do not refresh the page once the interview has started.</li>
            </ul>
          </CardBody>
        </Card>

        <div className="mt-5 flex justify-center">
          <Button size="lg" onClick={start} disabled={!micReady} loading={starting} className="px-8">
            <Video className="h-4 w-4" />
            Join the interview
          </Button>
        </div>
      </div>
    </div>
  );
}
