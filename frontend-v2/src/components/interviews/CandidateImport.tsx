'use client';

import { ChangeEvent, useRef, useState } from 'react';
import { Download, FileSpreadsheet, Trash2, Upload } from 'lucide-react';
import { Alert, Button, Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export interface ImportRow {
  row: number;
  name: string;
  email: string;
  mobile?: string;
  meetLink?: string;
  scheduledAt?: string;
  errors: Record<string, string>;
}

interface PreviewResponse {
  rows: ImportRow[];
  ignoredColumns: string[];
  blankRowsSkipped: number;
}

interface Props {
  rows: ImportRow[];
  onChange: (rows: ImportRow[]) => void;
  /** Shown in the empty per-row cells, so it is obvious what a blank inherits. */
  fallbackMeetLink: string;
  fallbackScheduledAt: string;
}

/**
 * Upload, then fix in place.
 *
 * The preview table is editable on purpose. A fifty-row shortlist almost always
 * has one bad cell, and sending the recruiter back to their spreadsheet to fix
 * it — then re-export, re-upload, re-check — is the difference between a
 * feature people use and one they do once.
 */
export function CandidateImport({ rows, onChange, fallbackMeetLink, fallbackScheduledAt }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setBusy(true);
    setError('');
    setNotice('');

    try {
      const body = new FormData();
      body.append('file', file);
      const { data } = await api.post<PreviewResponse>('/interviews/import/preview', body);

      onChange(data.rows);

      const notes: string[] = [`Read ${data.rows.length} row${data.rows.length === 1 ? '' : 's'} from ${file.name}.`];
      if (data.blankRowsSkipped) notes.push(`${data.blankRowsSkipped} blank row(s) skipped.`);
      if (data.ignoredColumns.length) notes.push(`Columns ignored: ${data.ignoredColumns.join(', ')}.`);
      setNotice(notes.join(' '));
    } catch (err) {
      setError(errorMessage(err, 'Could not read that file'));
    } finally {
      setBusy(false);
      // Cleared so choosing the same file again still fires a change event.
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const downloadTemplate = async () => {
    try {
      const res = await api.get('/interviews/import/template', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'candidates-template.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err, 'Could not download the template'));
    }
  };

  const edit = (index: number, field: keyof ImportRow, value: string) => {
    onChange(
      rows.map((r, i) => {
        if (i !== index) return r;
        // The old error on this field is dropped as soon as it is touched.
        // Re-validating in the browser would mean a second copy of the rules
        // that can disagree with the server's; the server has the last word
        // either way, and reports it per row.
        const errors = { ...r.errors };
        delete errors[field as string];
        return { ...r, [field]: value, errors };
      }),
    );
  };

  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));

  const badRows = rows.filter((r) => Object.keys(r.errors).length > 0).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={upload}
          className="hidden"
        />
        <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()} disabled={busy}>
          <Upload className="h-4 w-4" />
          {busy ? 'Reading…' : 'Upload CSV or Excel'}
        </Button>
        <Button type="button" variant="ghost" onClick={downloadTemplate}>
          <Download className="h-4 w-4" />
          Template
        </Button>
        {rows.length > 0 && (
          <span className="text-sm text-muted-foreground">
            {rows.length} candidate{rows.length === 1 ? '' : 's'}
            {badRows > 0 && <span className="text-danger"> · {badRows} need fixing</span>}
          </span>
        )}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {notice && !error && <Alert tone="info">{notice}</Alert>}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
          <FileSpreadsheet className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium text-foreground">No candidates yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload a file with a name and an email column. A meeting link and a date and time can be included per
            candidate — anything left blank uses the ones set below.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-2 py-2 font-medium">Row</th>
                <th className="px-2 py-2 font-medium">Name</th>
                <th className="px-2 py-2 font-medium">Email</th>
                <th className="px-2 py-2 font-medium">Mobile</th>
                <th className="px-2 py-2 font-medium">Meeting link</th>
                <th className="px-2 py-2 font-medium">Date and time</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.row}-${i}`} className="border-t border-border align-top">
                  <td className="px-2 py-2 text-muted-foreground">{r.row || i + 1}</td>
                  <Cell value={r.name} error={r.errors.name} onChange={(v) => edit(i, 'name', v)} />
                  <Cell value={r.email} error={r.errors.email} onChange={(v) => edit(i, 'email', v)} />
                  <Cell value={r.mobile ?? ''} error={r.errors.mobile} onChange={(v) => edit(i, 'mobile', v)} />
                  <Cell
                    value={r.meetLink ?? ''}
                    error={r.errors.meetLink}
                    placeholder={fallbackMeetLink ? 'Uses the link below' : 'Required'}
                    onChange={(v) => edit(i, 'meetLink', v)}
                  />
                  <Cell
                    value={toLocalInput(r.scheduledAt)}
                    error={r.errors.scheduledAt}
                    type="datetime-local"
                    placeholder={fallbackScheduledAt ? 'Uses the time below' : 'Required'}
                    onChange={(v) => edit(i, 'scheduledAt', v ? new Date(v).toISOString() : '')}
                  />
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      aria-label={`Remove ${r.name || 'row ' + r.row}`}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Cell({
  value,
  error,
  onChange,
  type,
  placeholder,
}: {
  value: string;
  error?: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <td className="px-2 py-2">
      <Input
        value={value}
        type={type}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={error ? 'border-danger' : undefined}
      />
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </td>
  );
}

/**
 * ISO to the value a datetime-local input wants.
 *
 * Unparseable input comes back as '', which shows the cell as empty. That is
 * not hiding anything: a datetime-local input cannot render "next tuesday"
 * whatever we do, and the parse error stays printed underneath the cell.
 */
function toLocalInput(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
