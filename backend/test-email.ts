import { emailService, verifyEmailSender } from './src/lib/email/EmailService';

async function test() {
    console.log('Verifying sender...');
    await verifyEmailSender();
    try {
        console.log('Sending test email...');
        await emailService.send({
            to: 'priyanshuraj9595@gmail.com',
            toName: 'Priyanshu',
            subject: 'Test Email from AI Interview',
            html: '<p>This is a test email.</p>',
            text: 'This is a test email.'
        });
        console.log('Test email sent successfully');
    } catch (e) {
        console.error('Failed to send email:', e);
    }
}

test();
