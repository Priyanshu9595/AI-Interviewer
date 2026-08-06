import fs from 'fs/promises';
import path from 'path';
import { UPLOAD_DIR, cloudinaryConfigured, deleteAsset, storeAsset } from '../src/lib/storage';

(async () => {
  console.log(`Cloudinary configured: ${cloudinaryConfigured}`);

  const buffer = Buffer.from('fake webm bytes for the storage round trip');

  const asset = await storeAsset({
    buffer,
    fileName: 'interview.webm',
    folder: 'ai-interview/recordings',
    publicId: 'storage-test',
    resourceType: 'video',
  });

  console.log('stored:', JSON.stringify(asset, null, 2));

  const checks: Array<[string, boolean]> = [];

  if (cloudinaryConfigured) {
    checks.push(['storage is CLOUDINARY', asset.storage === 'CLOUDINARY']);
    checks.push(['has a playable url', Boolean(asset.url?.startsWith('https://'))]);
    checks.push(['has a publicId for later deletion', Boolean(asset.publicId)]);
  } else {
    checks.push(['falls back to LOCAL', asset.storage === 'LOCAL']);
    checks.push(['has a relative filePath', Boolean(asset.filePath)]);

    const absolute = path.resolve(UPLOAD_DIR, asset.filePath ?? '');
    checks.push(['file stays inside uploads/', absolute.startsWith(UPLOAD_DIR)]);

    const exists = await fs
      .access(absolute)
      .then(() => true)
      .catch(() => false);
    checks.push(['file actually written to disk', exists]);
    checks.push(['byte count recorded', asset.bytes === buffer.length]);
  }

  await deleteAsset(asset);

  if (!cloudinaryConfigured && asset.filePath) {
    const gone = await fs
      .access(path.resolve(UPLOAD_DIR, asset.filePath))
      .then(() => false)
      .catch(() => true);
    checks.push(['delete removed the file', gone]);
  }

  console.log('\n=== assertions ===');
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }

  console.log(failed === 0 ? '\nSTORAGE OK' : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('STORAGE TEST FAILED:', err.message);
  process.exit(1);
});
