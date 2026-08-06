import { EmailService } from './src/lib/email/EmailService';
import { env } from './src/lib/env';

async function main() {
  const emailService = new EmailService();

  const to = process.argv[2];
  if (!to) {
    console.error('Please provide an email address as the first argument.');
    console.error('Usage: npx tsx test-email.ts <your-email@example.com>');
    process.exit(1);
  }

  console.log(`Sending test email to ${to} using Brevo...`);
  console.log(`Using API Key starting with: ${env.API_KEY_FOR_EMAIL?.substring(0, 15)}...`);

  try {
    await emailService.send({
      to,
      toName: 'Test User',
      subject: 'Test Email from AI Interview Platform',
      html: '<p>This is a test email sent using the configured Brevo API key.</p>',
      text: 'This is a test email sent using the configured Brevo API key.',
    });
    console.log('Test email sent successfully!');
  } catch (error) {
    console.error('Failed to send test email:', error);
  }
}

main();
