import fs from 'fs/promises';
import path from 'path';
import type { Page } from 'playwright';

/**
 * Saves what the page actually looked like when a join failed.
 *
 * Meeting clients change their interfaces constantly, and a broken selector
 * looks exactly like a broken network from the outside: `PRE_JOIN_NOT_FOUND`
 * and nothing else. A screenshot and the page's visible text turn a whole
 * afternoon of guessing into one look — and they are the only way to fix a
 * selector for a meeting you cannot reproduce yourself.
 *
 * Best effort throughout: a failure to record a failure must never replace it.
 */

const DEBUG_DIR = path.resolve(__dirname, '../../../uploads/bot-debug');

/** Keep the last few days only; these are diagnostics, not records. */
const MAX_AGE_MS = 3 * 24 * 60 * 60_000;

export interface DebugCapture {
  screenshot: string | null;
  text: string | null;
  url: string;
}

export async function captureFailure(
  page: Page,
  interviewId: string,
  label: string,
): Promise<DebugCapture> {
  const url = page.isClosed() ? '(page closed)' : page.url();
  if (page.isClosed()) return { screenshot: null, text: null, url };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${interviewId.slice(0, 8)}-${label}-${stamp}`;

  await fs.mkdir(DEBUG_DIR, { recursive: true }).catch(() => {});

  const screenshotPath = path.join(DEBUG_DIR, `${base}.png`);
  const textPath = path.join(DEBUG_DIR, `${base}.txt`);

  let screenshot: string | null = null;
  let text: string | null = null;

  try {
    await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 10_000 });
    screenshot = screenshotPath;
  } catch {
    // A page mid-navigation cannot be screenshotted. The text below usually can.
  }

  try {
    // Visible text plus every clickable control's accessible name. The second
    // part is what a selector is written against, so it is the more useful half.
    const dump = await page.evaluate(() => {
      const visible = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').slice(0, 6_000);

      const controls: string[] = [];
      const nodes = document.querySelectorAll(
        'button, [role="button"], input, a[href], [data-tid], [jsname]',
      );

      for (const el of Array.from(nodes).slice(0, 200)) {
        const tag = el.tagName.toLowerCase();
        const label =
          el.getAttribute('aria-label') ??
          el.getAttribute('title') ??
          el.getAttribute('placeholder') ??
          (el.textContent ?? '').trim().slice(0, 60);

        const hooks = ['data-tid', 'jsname', 'id', 'data-is-muted', 'type']
          .map((a) => (el.getAttribute(a) ? `${a}="${el.getAttribute(a)}"` : ''))
          .filter(Boolean)
          .join(' ');

        if (!label && !hooks) continue;
        const rect = el.getBoundingClientRect();
        const shown = rect.width > 0 && rect.height > 0 ? 'visible' : 'hidden';
        controls.push(`  <${tag} ${hooks}> ${shown} :: ${label}`);
      }

      return { visible, controls: controls.join('\n'), frames: window.frames.length };
    });

    const body = [
      `URL: ${url}`,
      `Captured: ${new Date().toISOString()}`,
      `Frames: ${dump.frames}`,
      '',
      '--- visible text ---',
      dump.visible,
      '',
      '--- controls ---',
      dump.controls,
    ].join('\n');

    await fs.writeFile(textPath, body, 'utf8');
    text = textPath;
  } catch {
    // Nothing more to do; the caller still gets its own error.
  }

  if (screenshot || text) {
    console.error(
      `[meet-bot ${interviewId}] saved join diagnostics: ${screenshot ?? ''}${screenshot && text ? ' and ' : ''}${text ?? ''}`,
    );
  }

  void pruneOldCaptures();

  return { screenshot, text, url };
}

async function pruneOldCaptures(): Promise<void> {
  try {
    const entries = await fs.readdir(DEBUG_DIR);
    const cutoff = Date.now() - MAX_AGE_MS;

    await Promise.all(
      entries.map(async (name) => {
        const file = path.join(DEBUG_DIR, name);
        const stat = await fs.stat(file).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) await fs.rm(file, { force: true }).catch(() => {});
      }),
    );
  } catch {
    // The directory may not exist yet. Nothing to prune.
  }
}
