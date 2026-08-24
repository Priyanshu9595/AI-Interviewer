'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { Alert, Button, Field, Input } from '@/components/ui';
import { errorMessage } from '@/lib/api';

/**
 * Signing up in two steps.
 *
 * The account does not exist until the code is confirmed, so leaving this page
 * on the second step costs nothing — there is no half-made row anywhere. The
 * details stay in component state so going back to fix a typo in the address
 * does not mean retyping the password.
 */
export default function RegisterPage() {
  const { startRegister, confirmRegister, resendRegisterCode } = useAuth();
  const router = useRouter();

  const [step, setStep] = useState<'details' | 'code'>('details');
  const [form, setForm] = useState({ name: '', company: '', email: '', password: '', confirm: '' });
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /** Seconds until the code dies, and until another can be sent. */
  const [expiresIn, setExpiresIn] = useState(0);
  const [resendIn, setResendIn] = useState(0);

  const codeInput = useRef<HTMLInputElement>(null);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  // One interval drives both countdowns; they only ever tick down.
  useEffect(() => {
    if (step !== 'code') return;

    const id = setInterval(() => {
      setExpiresIn((s) => (s > 0 ? s - 1 : 0));
      setResendIn((s) => (s > 0 ? s - 1 : 0));
    }, 1000);

    return () => clearInterval(id);
  }, [step]);

  useEffect(() => {
    if (step === 'code') codeInput.current?.focus();
  }, [step]);

  const sendCode = useCallback(async () => {
    const res = await startRegister({
      email: form.email,
      password: form.password,
      name: form.name || undefined,
      company: form.company || undefined,
    });
    setExpiresIn(res.expiresInSeconds);
    setResendIn(res.resendInSeconds);
  }, [form.email, form.password, form.name, form.company, startRegister]);

  const onDetails = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (form.password.length < 8) return setError('Password must be at least 8 characters.');
    if (form.password !== form.confirm) return setError('The two passwords do not match.');

    setSubmitting(true);
    try {
      await sendCode();
      setStep('code');
      setNotice(`We sent a six-digit code to ${form.email}.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not send your verification code'));
    } finally {
      setSubmitting(false);
    }
  };

  const onCode = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      await confirmRegister({ email: form.email, code });
      router.push('/dashboard');
    } catch (err) {
      setError(errorMessage(err, 'Could not verify that code'));
      setCode('');
      setSubmitting(false);
    }
  };

  const onResend = async () => {
    setError('');
    setNotice('');
    setSubmitting(true);

    try {
      const res = await resendRegisterCode(form.email);
      setCode('');
      setExpiresIn(res.expiresInSeconds);
      setResendIn(30);
      setNotice(`A new code is on its way to ${form.email}.`);
      codeInput.current?.focus();
    } catch (err) {
      setError(errorMessage(err, 'Could not send another code'));
    } finally {
      setSubmitting(false);
    }
  };

  // --- Step two: the code ---------------------------------------------------

  if (step === 'code') {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Check your email</h1>
          <p className="text-sm text-muted-foreground">
            Enter the six-digit code sent to <span className="font-medium text-foreground">{form.email}</span>.
          </p>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}
        {!error && notice && <Alert tone="info">{notice}</Alert>}

        <form onSubmit={onCode} className="space-y-5">
          <Field
            label="Verification code"
            hint={expiresIn > 0 ? `Expires in ${expiresIn}s` : 'This code has expired — send yourself a new one.'}
            required
          >
            <Input
              ref={codeInput}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              className="text-center text-2xl tracking-[0.4em]"
              required
            />
          </Field>

          <Button type="submit" className="w-full" size="lg" loading={submitting} disabled={code.length !== 6}>
            Verify and create account &rarr;
          </Button>
        </form>

        <div className="flex items-center justify-between text-sm">
          <button
            type="button"
            onClick={() => {
              setStep('details');
              setError('');
              setNotice('');
              setCode('');
            }}
            className="text-muted-foreground transition-colors hover:text-foreground hover:underline"
          >
            &larr; Change details
          </button>

          <button
            type="button"
            onClick={onResend}
            disabled={resendIn > 0 || submitting}
            className="font-medium text-primary transition-colors hover:text-primary-hover hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
          >
            {resendIn > 0 ? `Resend in ${resendIn}s` : 'Send a new code'}
          </button>
        </div>
      </div>
    );
  }

  // --- Step one: the details ------------------------------------------------

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Create an account</h1>
        <p className="text-sm text-muted-foreground">Start running AI-conducted interviews.</p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <form onSubmit={onDetails} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name">
            <Input value={form.name} onChange={set('name')} placeholder="Alex Doe" autoComplete="name" autoFocus />
          </Field>
          <Field label="Company">
            <Input value={form.company} onChange={set('company')} placeholder="Acme Inc." autoComplete="organization" />
          </Field>
        </div>

        <Field label="Work email" hint="We will send a code here to confirm it is yours." required>
          <Input
            type="email"
            value={form.email}
            onChange={set('email')}
            placeholder="you@company.com"
            autoComplete="email"
            required
          />
        </Field>

        <Field label="Password" hint="At least 8 characters." required>
          <Input
            type="password"
            value={form.password}
            onChange={set('password')}
            placeholder="Enter password"
            autoComplete="new-password"
            required
          />
        </Field>

        <Field label="Confirm password" required>
          <Input
            type="password"
            value={form.confirm}
            onChange={set('confirm')}
            placeholder="Confirm password"
            autoComplete="new-password"
            required
          />
        </Field>

        <Button type="submit" className="w-full" size="lg" loading={submitting}>
          Send verification code &rarr;
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-primary transition-colors hover:text-primary-hover hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
