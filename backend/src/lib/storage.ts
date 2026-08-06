import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import fs from 'fs/promises';
import path from 'path';
import { env } from './env';

export const UPLOAD_DIR = path.resolve(__dirname, '../../uploads');

export const cloudinaryConfigured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);

if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export interface StoredAsset {
  storage: 'CLOUDINARY' | 'LOCAL';
  /** Playable/downloadable URL, or null for local assets served via the API. */
  url: string | null;
  publicId: string | null;
  /** Relative path under uploads/, for local assets only. */
  filePath: string | null;
  bytes: number;
  durationSeconds: number;
}

/** Thrown when Cloudinary is the intended destination and it would not accept the asset. */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly httpCode?: number,
    readonly permissionProblem = false,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

interface StoreArgs {
  buffer: Buffer;
  fileName: string;
  folder: string;
  publicId: string;
  resourceType: 'video' | 'raw' | 'image' | 'auto';
  /**
   * When true, a Cloudinary failure throws instead of writing to local disk.
   * Used for interview recordings, which must not accumulate on the app server.
   */
  cloudOnly?: boolean;
}

/**
 * Stores an asset, preferring Cloudinary whenever it is configured.
 *
 * `cloudOnly` callers never silently fall back to local disk — a recording that
 * quietly lands on an ephemeral container filesystem looks stored but is lost on
 * the next deploy, which is worse than a visible failure the caller can retry.
 */
export async function storeAsset(args: StoreArgs): Promise<StoredAsset> {
  if (cloudinaryConfigured) {
    try {
      const result = await uploadWithRetry(args);
      return {
        storage: 'CLOUDINARY',
        url: result.secure_url,
        publicId: result.public_id,
        filePath: null,
        bytes: result.bytes ?? args.buffer.length,
        durationSeconds: Math.round(result.duration ?? 0),
      };
    } catch (err) {
      const storageError = toStorageError(err);

      if (args.cloudOnly) throw storageError;

      console.error(`[storage] Cloudinary upload failed, keeping it locally: ${storageError.message}`);
    }
  } else if (args.cloudOnly) {
    // Local is an acceptable destination only when Cloudinary was never set up.
    console.warn('[storage] Cloudinary is not configured — storing on local disk instead');
  }

  return storeLocally(args.buffer, args.fileName, args.folder);
}

function toStorageError(err: unknown): StorageError {
  const message = (err as Error)?.message ?? String(err);
  const httpCode = (err as { http_code?: number })?.http_code;
  const permissionProblem = /missing permissions|forbidden/i.test(message) || httpCode === 403;

  return new StorageError(
    permissionProblem
      ? `Cloudinary rejected the upload: the API key lacks upload ("create") permission. ${message}`
      : message,
    httpCode,
    permissionProblem,
  );
}

/** Transient network blips deserve a retry; a permissions problem does not. */
async function uploadWithRetry(args: StoreArgs): Promise<UploadApiResponse> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await uploadBuffer(args);
    } catch (err) {
      lastError = err;
      if (toStorageError(err).permissionProblem) break;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }

  throw lastError;
}

function uploadBuffer(args: StoreArgs): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: args.folder,
        public_id: args.publicId,
        resource_type: args.resourceType,
        overwrite: true,
        // Recordings can be long; the default 60s is often not enough.
        timeout: 180_000,
      },
      (error, result) => {
        if (error) return reject(error);
        if (!result) return reject(new Error('Cloudinary returned no result'));
        resolve(result);
      },
    );

    stream.end(args.buffer);
  });
}

async function storeLocally(buffer: Buffer, fileName: string, folder: string): Promise<StoredAsset> {
  const dir = path.join(UPLOAD_DIR, folder);
  await fs.mkdir(dir, { recursive: true });

  const safe = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const absolute = path.join(dir, `${Date.now()}-${safe}`);
  await fs.writeFile(absolute, buffer);

  return {
    storage: 'LOCAL',
    url: null,
    publicId: null,
    filePath: path.relative(UPLOAD_DIR, absolute).split(path.sep).join('/'),
    bytes: buffer.length,
    durationSeconds: 0,
  };
}

export async function deleteAsset(asset: {
  storage: string;
  publicId: string | null;
  filePath: string | null;
}): Promise<void> {
  if (asset.storage === 'CLOUDINARY' && asset.publicId && cloudinaryConfigured) {
    await cloudinary.uploader
      .destroy(asset.publicId, { resource_type: 'video' })
      .catch((err) => console.error('[storage] Cloudinary delete failed:', err.message));
    return;
  }

  if (asset.filePath) {
    const absolute = path.resolve(UPLOAD_DIR, asset.filePath);
    // Never follow a path that escapes the uploads directory.
    if (absolute.startsWith(UPLOAD_DIR)) await fs.unlink(absolute).catch(() => {});
  }
}

export type CloudinaryStatus = 'disabled' | 'ok' | 'no-upload-permission' | 'unreachable';

let cloudinaryStatus: CloudinaryStatus = cloudinaryConfigured ? 'unreachable' : 'disabled';

export const getCloudinaryStatus = () => cloudinaryStatus;

/**
 * Confirms at boot that Cloudinary will actually accept uploads.
 *
 * Valid credentials are not enough: Cloudinary supports scoped API keys, and a
 * key without the "create" action authenticates fine but rejects every upload.
 * Finding that out at boot beats finding out when a candidate's interview ends.
 */
export async function verifyCloudinary(): Promise<CloudinaryStatus> {
  if (!cloudinaryConfigured) {
    console.log('[storage] Cloudinary not configured — recordings and resumes will use local disk');
    cloudinaryStatus = 'disabled';
    return cloudinaryStatus;
  }

  try {
    // A 1x1 PNG is the cheapest real asset we can round-trip.
    const probe = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );

    const result = await uploadBuffer({
      buffer: probe,
      fileName: 'startup-probe.png',
      folder: 'ai-interview/_probe',
      publicId: 'startup-probe',
      resourceType: 'image',
    });

    await cloudinary.uploader.destroy(result.public_id, { resource_type: 'image' }).catch(() => {});

    console.log(`[storage] Cloudinary ready (cloud "${env.CLOUDINARY_CLOUD_NAME}") — recordings will be uploaded there`);
    cloudinaryStatus = 'ok';
  } catch (err) {
    const storageError = toStorageError(err);
    cloudinaryStatus = storageError.permissionProblem ? 'no-upload-permission' : 'unreachable';

    if (storageError.permissionProblem) {
      console.error(
        `[storage] Cloudinary credentials are valid but this API key CANNOT UPLOAD.\n` +
          `[storage] Fix: Cloudinary Console > Settings > API Keys > edit key ${env.CLOUDINARY_API_KEY} and\n` +
          `[storage]      enable the upload ("create") permission, or use the account's master API key.\n` +
          `[storage] Until then, recordings cannot be stored.`,
      );
    } else {
      console.error(`[storage] Cloudinary is unreachable: ${storageError.message}`);
    }
  }

  return cloudinaryStatus;
}
