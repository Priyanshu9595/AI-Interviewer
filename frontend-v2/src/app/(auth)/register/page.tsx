'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { Alert, Button, Field, Input } from '@/components/ui';
import { errorMessage } from '@/lib/api';

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();

  const [form, setForm] = useState({ name: '', company: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (form.password.length < 8) return setError('Password must be at least 8 characters.');
    if (form.password !== form.confirm) return setError('The two passwords do not match.');

    setSubmitting(true);
    try {
      await register({
        email: form.email,
        password: form.password,
        name: form.name || undefined,
        company: form.company || undefined,
      });
      router.push('/dashboard');
    } catch (err) {
      setError(errorMessage(err, 'Could not create your account'));
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Create an account</h1>
        <p className="text-sm text-muted-foreground">Start running AI-conducted interviews.</p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <form onSubmit={onSubmit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name">
            <Input value={form.name} onChange={set('name')} placeholder="Alex Doe" autoComplete="name" autoFocus />
          </Field>
          <Field label="Company">
            <Input value={form.company} onChange={set('company')} placeholder="Acme Inc." autoComplete="organization" />
          </Field>
        </div>

        <Field label="Work email" required>
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
          Create account &rarr;
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
