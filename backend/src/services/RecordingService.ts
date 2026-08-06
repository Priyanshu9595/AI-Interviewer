import { appendFile, mkdir, readFile, readdir, rm, stat } from 'fs/promises';
import path from 'path';
import { UPLOAD_DIR, deleteAsset, getCloudinaryStatus, storeAsset } from '../lib/storage';
import { prisma } from '../lib/prisma';

const CHUNK_DIR = path.join(UPLOAD_DIR, 'in-progress');

/**
 * Interview recordings are streamed to the server while the interview is
 * running, not held in the browser until the end.
 *
 * The original design buffered everything in memory and uploaded once on
 * completion, so closing the tab, refreshing, or dropping the socket lost the
 * entire recording — which is exactly what happened in practice. Appending each
 * chunk as it arrives means whatever was captured survives, even from an
 * interview that ended abruptly.
 */
export class RecordingService {
  private static partPath(sessionCandidateId: string) {
    // The id is a UUID from our own database, so it cannot traverse.
    return path.join(CHUNK_DIR, `${sessionCandidateId}.webm.part`);
  }

  /** Appends one MediaRecorder chunk to the in-progress file. */
  static async appendChunk(sessionCandidateId: string, chunk: Buffer): Promise<number> {
    await mkdir(CHUNK_DIR, { recursive: true });
    const file = this.partPath(sessionCandidateId);
    await appendFile(file, chunk);
    const { size } = await stat(file);
    return size;
  }

  static async partialSize(sessionCandidateId: string): Promise<number> {
    try {
      const { size } = await stat(this.partPath(sessionCandidateId));
      return size;
    } catch {
      return 0;
    }
  }

  /**
   * Turns the accumulated chunks into a stored recording. Safe to call more
   * than once and safe to call when nothing was captured.
   */
  static async finalise(
    sessionCandidateId: string,
    opts: { mimeType?: string; durationSeconds?: number } = {},
  ): Promise<{ stored: boolean; reason?: string; retryable?: boolean; sizeBytes?: number }> {
    const file = this.partPath(sessionCandidateId);

    let buffer: Buffer;
    try {
      buffer = await readFile(file);
    } catch {
      return { stored: false, reason: 'nothing was captured' };
    }

    // A couple of kilobytes is a header with no frames — not worth storing.
    if (buffer.length < 4096) {
      await rm(file, { force: true }).catch(() => {});
      return { stored: false, reason: 'captured data was too small to be a usable recording' };
    }

    const session = await prisma.sessionCandidate.findUnique({
      where: { id: sessionCandidateId },
      select: { interviewSession: { select: { recordingEnabled: true } } },
    });

    if (!session?.interviewSession.recordingEnabled) {
      await rm(file, { force: true }).catch(() => {});
      return { stored: false, reason: 'recording is disabled for this session' };
    }

    // Replacing an earlier recording must not orphan the old asset.
    const previous = await prisma.recording.findUnique({ where: { sessionCandidateId } });
    if (previous) await deleteAsset(previous);

    let asset;
    try {
      asset = await storeAsset({
        buffer,
        fileName: `${sessionCandidateId}.webm`,
        folder: 'ai-interview/recordings',
        publicId: sessionCandidateId,
        resourceType: 'video',
        // Never leave recordings sitting in the app's uploads folder.
        cloudOnly: true,
      });
    } catch (err) {
      // Keep the part file so the upload can be retried once the problem is
      // fixed, rather than discarding the interview.
      const reason = (err as Error).message;
      console.error(`[recording] could not upload ${sessionCandidateId}, keeping it queued: ${reason}`);
      return { stored: false, reason, retryable: true, sizeBytes: buffer.length };
    }

    const data = {
      url: asset.url,
      publicId: asset.publicId,
      storage: asset.storage,
      filePath: asset.filePath,
      mimeType: opts.mimeType ?? 'video/webm',
      sizeBytes: asset.bytes,
      durationSeconds: asset.durationSeconds || opts.durationSeconds || 0,
    };

    await prisma.recording.upsert({
      where: { sessionCandidateId },
      create: { sessionCandidateId, ...data },
      update: data,
    });

    await rm(file, { force: true }).catch(() => {});

    console.log(
      `[recording] stored ${(buffer.length / 1024 / 1024).toFixed(1)} MB for ${sessionCandidateId} (${asset.storage})`,
    );

    return { stored: true, sizeBytes: buffer.length };
  }

  /** Discards a partial file, e.g. when an interview is deleted. */
  static async discard(sessionCandidateId: string) {
    await rm(this.partPath(sessionCandidateId), { force: true }).catch(() => {});
  }

  /**
   * Retries recordings whose upload failed — typically because Cloudinary was
   * misconfigured at the time. Once the credentials are fixed these upload on
   * the next scheduler tick with no manual step.
   */
  static async retryQueued(): Promise<number> {
    // Nothing can succeed while Cloudinary is still refusing uploads.
    if (getCloudinaryStatus() === 'no-upload-permission') return 0;

    let names: string[];
    try {
      names = await readdir(CHUNK_DIR);
    } catch {
      return 0;
    }

    const pending = names.filter((n) => n.endsWith('.webm.part'));
    if (!pending.length) return 0;

    let uploaded = 0;

    for (const name of pending.slice(0, 3)) {
      const sessionCandidateId = name.replace('.webm.part', '');

      // Only retry interviews that are actually over; a live one is still growing.
      const sc = await prisma.sessionCandidate.findUnique({
        where: { id: sessionCandidateId },
        select: { status: true },
      });

      if (!sc) {
        await this.discard(sessionCandidateId);
        continue;
      }
      if (!['COMPLETED', 'ABSENT', 'CANCELLED'].includes(sc.status)) continue;

      const result = await this.finalise(sessionCandidateId);
      if (result.stored) {
        console.log(`[recording] queued upload succeeded for ${sessionCandidateId}`);
        uploaded++;
      }
    }

    return uploaded;
  }

  /** How many recordings are waiting to be uploaded. */
  static async queuedCount(): Promise<number> {
    try {
      const names = await readdir(CHUNK_DIR);
      return names.filter((n) => n.endsWith('.webm.part')).length;
    } catch {
      return 0;
    }
  }
}
