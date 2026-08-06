'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Plug, Plus, Trash2, XCircle, Zap } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { useToast } from '@/components/Toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

interface Integration {
  id: string;
  provider: string;
  name: string;
  webhookUrl: string | null;
  enabled: boolean;
  hasApiKey: boolean;
  createdAt: string;
  _count: { syncLogs: number };
}

interface SyncLog {
  id: string;
  success: boolean;
  responseStatus: number | null;
  message: string | null;
  createdAt: string;
}

const PROVIDERS = [
  { value: 'GREENHOUSE', label: 'Greenhouse', note: 'Sends the API key as HTTP Basic auth.' },
  { value: 'LEVER', label: 'Lever', note: 'Sends the API key as a bearer token.' },
  { value: 'WORKABLE', label: 'Workable', note: 'Sends the API key as a bearer token.' },
  { value: 'WEBHOOK', label: 'Generic webhook', note: 'Posts the report JSON to any URL you control.' },
];

export default function IntegrationsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ id: string; entries: SyncLog[] } | null>(null);

  const [form, setForm] = useState({ provider: 'WEBHOOK', name: '', webhookUrl: '', apiKey: '' });

  const load = useCallback(async () => {
    try {
      const res = await api.get<Integration[]>('/ats/integrations');
      setRows(res.data);
    } catch (err) {
      toast.error('Could not load integrations', errorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/ats/integrations', {
        provider: form.provider,
        name: form.name,
        webhookUrl: form.webhookUrl,
        apiKey: form.apiKey || undefined,
      });
      toast.success('Integration added');
      setForm({ provider: 'WEBHOOK', name: '', webhookUrl: '', apiKey: '' });
      setAdding(false);
      void load();
    } catch (err) {
      toast.error('Could not add the integration', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: Integration) => {
    if (!confirm(`Delete the "${row.name}" integration?`)) return;
    try {
      await api.delete(`/ats/integrations/${row.id}`);
      toast.success('Integration deleted');
      void load();
    } catch (err) {
      toast.error('Could not delete the integration', errorMessage(err));
    }
  };

  const test = async (row: Integration) => {
    setTesting(row.id);
    try {
      const res = await api.post<{ success: boolean; responseStatus: number }>(`/ats/integrations/${row.id}/test`);
      toast.success('Test succeeded', `Endpoint responded with ${res.data.responseStatus}.`);
      void load();
    } catch (err) {
      toast.error('Test failed', errorMessage(err));
    } finally {
      setTesting(null);
    }
  };

  const showLogs = async (row: Integration) => {
    try {
      const res = await api.get<SyncLog[]>(`/ats/integrations/${row.id}/logs`);
      setLogs({ id: row.id, entries: res.data });
    } catch (err) {
      toast.error('Could not load the sync history', errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Push completed candidate reports into your applicant tracking system."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            Add integration
          </Button>
        }
      />

      <Alert tone="info" className="mb-4">
        Every provider receives the same JSON payload: candidate details, the four scores, the hiring recommendation,
        strengths, weaknesses and a link back to the full report. Send it from a report page, or automatically after
        every evaluation.
      </Alert>

      {loading ? (
        <Skeleton className="h-64" />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Plug}
            title="No integrations yet"
            description="Add a webhook and completed reports can be pushed into your ATS with one click."
            action={
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" />
                Add integration
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <Card key={row.id}>
              <CardBody>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground">{row.name}</h3>
                      <Badge tone="primary">{PROVIDERS.find((p) => p.value === row.provider)?.label ?? row.provider}</Badge>
                      {row.enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}
                      {row.hasApiKey && <Badge>API key set</Badge>}
                    </div>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{row.webhookUrl}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {row._count.syncLogs} sync{row._count.syncLogs === 1 ? '' : 's'} · added{' '}
                      {formatDateTime(row.createdAt)}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => showLogs(row)}>
                      History
                    </Button>
                    <Button variant="outline" size="sm" loading={testing === row.id} onClick={() => test(row)}>
                      <Zap className="h-4 w-4" />
                      Test
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => remove(row)} title="Delete">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {/* Add */}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add an ATS integration"
        description="Reports are POSTed as JSON to the URL you provide."
        footer={
          <>
            <Button variant="outline" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button form="add-integration" type="submit" loading={saving}>
              Add integration
            </Button>
          </>
        }
      >
        <form id="add-integration" onSubmit={create} className="space-y-4">
          <Field label="Provider" hint={PROVIDERS.find((p) => p.value === form.provider)?.note}>
            <Select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Name" required>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Engineering pipeline"
              required
              autoFocus
            />
          </Field>

          <Field label="Webhook URL" required hint="Must be a URL you control and can receive POST requests on.">
            <Input
              type="url"
              value={form.webhookUrl}
              onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })}
              placeholder="https://api.yourcompany.com/hooks/interviews"
              required
            />
          </Field>

          <Field label="API key" hint="Optional. Stored server-side and never returned to the browser.">
            <Input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder="••••••••"
              autoComplete="off"
            />
          </Field>
        </form>
      </Modal>

      {/* Sync history */}
      <Modal open={Boolean(logs)} onClose={() => setLogs(null)} title="Sync history" size="lg">
        {logs?.entries.length ? (
          <ul className="space-y-2">
            {logs.entries.map((log) => (
              <li key={log.id} className="flex items-start gap-2.5 rounded-md border border-border p-3 text-sm">
                {log.success ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">
                    {log.success ? 'Delivered' : 'Failed'}
                    {log.responseStatus ? ` · HTTP ${log.responseStatus}` : ''}
                  </p>
                  {log.message && <p className="mt-0.5 break-words text-xs text-muted-foreground">{log.message}</p>}
                  <p className="mt-0.5 text-xs text-muted-foreground">{formatDateTime(log.createdAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">Nothing has been synced yet.</p>
        )}
      </Modal>
    </>
  );
}
