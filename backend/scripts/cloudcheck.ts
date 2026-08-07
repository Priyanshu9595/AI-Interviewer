import { verifyCloudinary, getCloudinaryStatus } from '../src/lib/storage';

(async () => {
  const status = await verifyCloudinary();
  console.log(`\nstatus: ${status} (${getCloudinaryStatus()})`);
  process.exit(status === 'ok' ? 0 : 1);
})();
