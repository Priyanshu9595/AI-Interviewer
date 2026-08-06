'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface FrameMetrics {
  facePresence: number;
  motion: number;
  gazeStability: number;
  expression: string | null;
}

export interface LiveVideoStats {
  facePresent: boolean;
  confidence: number;
  motion: number;
  centred: boolean;
}

const SAMPLE_W = 64;
const SAMPLE_H = 48;

/**
 * Detects skin-toned pixels using the widely-cited RGB rule from Kovac et al.
 * It is deliberately coarse: the goal is "is a face roughly here and steady",
 * not identification.
 */
function isSkin(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return (
    r > 95 && g > 40 && b > 20 && max - min > 15 && Math.abs(r - g) > 15 && r > g && r > b
  );
}

/**
 * Samples the candidate's webcam entirely in the browser and derives aggregate
 * presence, motion and steadiness numbers.
 *
 * No pixel data ever leaves the device — only the four numbers below are sent,
 * and only when the recruiter enabled video analysis for the session.
 */
export function useVideoAnalysis({
  videoRef,
  enabled,
  onBatch,
  sampleIntervalMs = 1000,
  batchSize = 15,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  enabled: boolean;
  onBatch: (frames: FrameMetrics[]) => void;
  sampleIntervalMs?: number;
  batchSize?: number;
}) {
  const [stats, setStats] = useState<LiveVideoStats>({
    facePresent: false,
    confidence: 0,
    motion: 0,
    centred: false,
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previousRef = useRef<Uint8ClampedArray | null>(null);
  const centroidRef = useRef<Array<{ x: number; y: number }>>([]);
  const bufferRef = useRef<FrameMetrics[]>([]);
  const onBatchRef = useRef(onBatch);

  useEffect(() => {
    onBatchRef.current = onBatch;
  }, [onBatch]);

  const flush = useCallback(() => {
    if (!bufferRef.current.length) return;
    const batch = bufferRef.current;
    bufferRef.current = [];
    onBatchRef.current(batch);
  }, []);

  const sample = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0) return;

    canvasRef.current ??= document.createElement('canvas');
    const canvas = canvasRef.current;
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);

    let pixels: Uint8ClampedArray;
    try {
      pixels = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    } catch {
      // A tainted canvas means we simply cannot analyse; fail quiet.
      return;
    }

    // --- Face presence and position via skin-tone centroid -----------------
    let skinCount = 0;
    let sumX = 0;
    let sumY = 0;

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i] ?? 0;
      const g = pixels[i + 1] ?? 0;
      const b = pixels[i + 2] ?? 0;

      if (isSkin(r, g, b)) {
        const px = (i / 4) % SAMPLE_W;
        const py = Math.floor(i / 4 / SAMPLE_W);
        skinCount++;
        sumX += px;
        sumY += py;
      }
    }

    const totalPixels = SAMPLE_W * SAMPLE_H;
    const skinRatio = skinCount / totalPixels;

    // A face at normal webcam distance covers roughly 4-35% of the frame.
    const facePresence = Math.max(0, Math.min(1, skinRatio > 0.02 ? Math.min(1, skinRatio / 0.12) : 0));
    const facePresent = skinRatio > 0.025;

    // --- Motion via mean absolute luminance difference ---------------------
    let motion = 0;
    const previous = previousRef.current;

    if (previous && previous.length === pixels.length) {
      let diff = 0;
      // Every 4th pixel is plenty at this resolution and 4x cheaper.
      for (let i = 0; i < pixels.length; i += 16) {
        diff += Math.abs((pixels[i] ?? 0) - (previous[i] ?? 0));
      }
      const samples = Math.ceil(pixels.length / 16);
      motion = Math.min(1, diff / samples / 40);
    }
    previousRef.current = new Uint8ClampedArray(pixels);

    // --- Gaze stability: how still and centred the face stays --------------
    let gazeStability = 0;
    let centred = false;

    if (facePresent && skinCount > 0) {
      const cx = sumX / skinCount;
      const cy = sumY / skinCount;

      const history = centroidRef.current;
      history.push({ x: cx, y: cy });
      if (history.length > 8) history.shift();

      // Steadiness: low variance in the centroid across recent frames.
      let variance = 0;
      if (history.length > 1) {
        const mx = history.reduce((a, p) => a + p.x, 0) / history.length;
        const my = history.reduce((a, p) => a + p.y, 0) / history.length;
        variance =
          history.reduce((a, p) => a + Math.hypot(p.x - mx, p.y - my), 0) / history.length;
      }
      const steadiness = Math.max(0, 1 - variance / 6);

      // Centring: how close the face is to the middle of the frame.
      const offset = Math.hypot(cx - SAMPLE_W / 2, cy - SAMPLE_H / 2);
      const maxOffset = Math.hypot(SAMPLE_W / 2, SAMPLE_H / 2);
      const centering = Math.max(0, 1 - offset / maxOffset);
      centred = centering > 0.6;

      gazeStability = Math.max(0, Math.min(1, steadiness * 0.55 + centering * 0.45));
    } else {
      centroidRef.current = [];
    }

    // --- Expression heuristic ---------------------------------------------
    const confidence = Math.max(
      0,
      Math.min(1, facePresence * 0.45 + gazeStability * 0.45 - (motion > 0.45 ? (motion - 0.45) * 0.45 : 0) + 0.05),
    );

    let expression: string;
    if (!facePresent) expression = 'ABSENT';
    else if (motion > 0.6) expression = 'RESTLESS';
    else if (confidence > 0.72) expression = 'ENGAGED';
    else if (gazeStability < 0.35) expression = 'DISTRACTED';
    else if (confidence < 0.4) expression = 'TENSE';
    else expression = 'NEUTRAL';

    setStats({ facePresent, confidence, motion, centred });

    bufferRef.current.push({
      facePresence: Math.round(facePresence * 100) / 100,
      motion: Math.round(motion * 100) / 100,
      gazeStability: Math.round(gazeStability * 100) / 100,
      expression,
    });

    if (bufferRef.current.length >= batchSize) flush();
  }, [videoRef, batchSize, flush]);

  useEffect(() => {
    if (!enabled) return;

    const timer = setInterval(sample, sampleIntervalMs);
    return () => {
      clearInterval(timer);
      // Do not lose the tail of the session on unmount.
      flush();
    };
  }, [enabled, sample, sampleIntervalMs, flush]);

  return { stats, flush };
}
