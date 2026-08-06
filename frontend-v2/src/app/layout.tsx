import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { AuthProvider } from '@/components/AuthProvider';
import { ToastProvider } from '@/components/Toast';
import './globals.css';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'AI Interview Platform',
  description:
    'Create interview sessions, let an AI interviewer run technical and HR rounds by voice, and get scored candidate reports with hiring recommendations.',
};

/**
 * Without this, mobile browsers assume a 980px desktop layout and zoom out,
 * which makes every screen unreadable on a phone.
 *
 * `maximumScale` is deliberately left at the default so pinch-zoom keeps
 * working — disabling it is an accessibility failure.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#4f46e5',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
