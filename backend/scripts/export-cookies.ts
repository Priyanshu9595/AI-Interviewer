import { chromium } from 'playwright';
import { MASTER_PROFILE_DIR, hasSignedInProfile } from '../src/services/meetingBot/browser';

/**
 * Reads the authenticated cookies from the local Chromium profile
 * and exports them as a base64-encoded string.
 * This is used to bypass the need for a persistent disk on Render Free tier.
 */
async function main() {
  if (!(await hasSignedInProfile())) {
    console.error('\n  ✗ No signed-in profile found.');
    console.error('    Please run `npm run bot:login` first and sign in to Google.');
    process.exit(1);
  }

  console.log('\n  Extracting cookies from the local profile...');

  // Launch headlessly just to grab the cookies from the disk
  const context = await chromium.launchPersistentContext(MASTER_PROFILE_DIR, {
    headless: true,
  });

  const cookies = await context.cookies();
  await context.close();

  if (cookies.length === 0) {
    console.error('\n  ✗ Profile found, but no cookies were retrieved.');
    console.error('    Are you sure you completed the sign in process?');
    process.exit(1);
  }

  const base64Cookies = Buffer.from(JSON.stringify(cookies)).toString('base64');

  console.log('\n  ✓ Cookies extracted successfully!\n');
  console.log('  ------------------------------------------------');
  console.log('  Copy the string below and paste it as the value for');
  console.log('  the GOOGLE_BOT_COOKIES environment variable in Render:');
  console.log('  ------------------------------------------------\n');
  
  console.log(base64Cookies);
  
  console.log('\n  ------------------------------------------------\n');
}

main().catch((err) => {
  console.error('\n  Export failed:', err.message, '\n');
  process.exit(1);
});
