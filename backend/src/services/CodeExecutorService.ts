import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { env } from '../lib/env';

export interface TestCase {
  input: string;
  output: string;
  hidden?: boolean;
}

export interface CaseResult {
  index: number;
  hidden: boolean;
  passed: boolean;
  input: string;
  expected: string;
  actual: string;
  stderr?: string;
  timedOut?: boolean;
  runtimeMs: number;
}

export interface ExecutionResult {
  passed: number;
  total: number;
  runtimeMs: number;
  compileError?: string;
  unsupported?: string;
  cases: CaseResult[];
}

type LanguageId = 'javascript' | 'python' | 'cpp' | 'java';

const LANGUAGE_ALIASES: Record<string, LanguageId> = {
  javascript: 'javascript', js: 'javascript', node: 'javascript', typescript: 'javascript',
  python: 'python', py: 'python', python3: 'python',
  cpp: 'cpp', 'c++': 'cpp', cc: 'cpp',
  java: 'java',
};

/**
 * Patterns with no legitimate place in an interview answer: spawning
 * processes, opening sockets, or touching the filesystem.
 *
 * Note that reading stdin is deliberately NOT on this list — the harness below
 * hands the candidate their input as a variable, so they never need `fs`.
 */
const BANNED = [
  /\bchild_process\b/, /\bsubprocess\b/, /\bshutil\b/, /\bsocket\b/,
  /\brequire\s*\(\s*['"](fs|net|http|https|dgram|cluster|worker_threads|vm)['"]/,
  /\bimport\s+(os|subprocess|socket|shutil|ctypes)\b/, /\bfrom\s+(os|subprocess|socket)\s+import\b/,
  /\bos\.(system|popen|remove|rmdir|unlink|execv?)\b/, /\b__import__\b/,
  /\bRuntime\.getRuntime\b/, /\bProcessBuilder\b/,
  /\bjava\.(io\.File|net|nio\.file)\b/,
  /\b(system|fstream|fopen|remove|popen)\s*\(/i,
];

/**
 * Prelude injected ahead of the candidate's JavaScript.
 *
 * Node has no built-in synchronous stdin reader, and the usual idiom needs
 * `fs`, which the ban list blocks. Reading it here — outside the candidate's
 * code — gives them `input`, `lines` and `readline()` with no imports at all.
 */
const JS_HARNESS = `'use strict';
const __raw = (() => { try { return require('fs').readFileSync(0, 'utf8'); } catch { return ''; } })();
const input = __raw;
const lines = __raw.split(/\\r?\\n/);
let __lineCursor = 0;
const readline = () => lines[__lineCursor++];
const readInts = () => (readline() || '').trim().split(/\\s+/).filter(Boolean).map(Number);
// ---- candidate code ----
`;

/** Number of harness lines, so reported error lines map back to the real file. */
const JS_HARNESS_LINES = JS_HARNESS.split('\n').length - 1;

/** Rewrites stack-trace line numbers to match what the candidate wrote. */
function realignJsStack(stderr: string): string {
  return stderr.replace(/main\.js:(\d+)/g, (match, line: string) => {
    const actual = Number(line) - JS_HARNESS_LINES;
    return actual > 0 ? `main.js:${actual}` : match;
  });
}

/** Trailing-whitespace-insensitive comparison; models and humans differ on it. */
function outputMatches(actual: string, expected: string): boolean {
  const norm = (s: string) =>
    s.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();
  return norm(actual) === norm(expected);
}

export class CodeExecutorService {
  private static tempRoot = path.join(os.tmpdir(), 'ai-interview-exec');

  static normaliseLanguage(language: string): LanguageId | null {
    return LANGUAGE_ALIASES[language.trim().toLowerCase()] ?? null;
  }

  static async execute(language: string, code: string, testCases: TestCase[]): Promise<ExecutionResult> {
    const total = testCases.length;
    const empty: ExecutionResult = { passed: 0, total, runtimeMs: 0, cases: [] };

    if (!env.CODE_EXEC_ENABLED) {
      return { ...empty, unsupported: 'Code execution is disabled on this server.' };
    }

    const lang = this.normaliseLanguage(language);
    if (!lang) return { ...empty, unsupported: `Unsupported language: ${language}` };

    const offending = BANNED.find((re) => re.test(code));
    if (offending) {
      return { ...empty, compileError: 'Submission uses a disallowed API (file, process or network access).' };
    }

    if (!total) return empty;

    const runId = crypto.randomUUID();
    const dir = path.join(this.tempRoot, runId);
    await fs.mkdir(dir, { recursive: true });

    const startedAt = Date.now();
    try {
      const prepared = await this.prepare(lang, dir, code);
      if ('compileError' in prepared) {
        return { ...empty, compileError: prepared.compileError, runtimeMs: Date.now() - startedAt };
      }

      const cases: CaseResult[] = [];
      let passed = 0;

      for (let i = 0; i < testCases.length; i++) {
        const testCase = testCases[i] as TestCase;
        const caseStart = Date.now();
        const run = await this.run(prepared.command, prepared.args, dir, testCase.input);
        const actual = run.stdout.trim();
        const ok = !run.timedOut && run.exitCode === 0 && outputMatches(actual, testCase.output);

        if (ok) passed++;
        cases.push({
          index: i,
          hidden: testCase.hidden ?? false,
          passed: ok,
          input: testCase.input,
          expected: testCase.output.trim(),
          actual,
          stderr:
            (lang === 'javascript' ? realignJsStack(run.stderr) : run.stderr).trim().slice(0, 2000) || undefined,
          timedOut: run.timedOut,
          runtimeMs: Date.now() - caseStart,
        });
      }

      return { passed, total, runtimeMs: Date.now() - startedAt, cases };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private static async prepare(
    lang: LanguageId,
    dir: string,
    code: string,
  ): Promise<{ command: string; args: string[] } | { compileError: string }> {
    if (lang === 'javascript') {
      const file = path.join(dir, 'main.js');
      await fs.writeFile(file, JS_HARNESS + code);
      return { command: process.execPath, args: [file] };
    }

    if (lang === 'python') {
      const file = path.join(dir, 'main.py');
      await fs.writeFile(file, code);
      const python = process.platform === 'win32' ? 'python' : 'python3';
      return { command: python, args: [file] };
    }

    if (lang === 'cpp') {
      const src = path.join(dir, 'main.cpp');
      const exe = path.join(dir, process.platform === 'win32' ? 'main.exe' : 'main');
      await fs.writeFile(src, code);

      // No -O2. Optimising a interview answer buys nothing measurable and
      // costs a great deal: with <bits/stdc++.h> it is the difference between
      // a compiler that needs a couple of hundred megabytes and one that needs
      // most of a gigabyte. On a box that is also running a browser in a live
      // meeting, that is what gets the compiler killed.
      const compile = await this.run('g++', ['-std=c++17', '-o', exe, src], dir, '', 30_000);
      if (compile.exitCode !== 0) {
        return { compileError: describeCompileFailure(compile, 'g++') };
      }
      return { command: exe, args: [] };
    }

    // Java requires the public class to be named Main.
    const src = path.join(dir, 'Main.java');
    await fs.writeFile(src, code);
    // -J-Xmx256m caps the JVM running javac. Left to itself it sizes its heap
    // from total system memory and will happily reserve more than is free.
    const compile = await this.run('javac', ['-J-Xmx256m', '-d', dir, src], dir, '', 30_000);
    if (compile.exitCode !== 0) {
      return { compileError: describeCompileFailure(compile, 'javac') };
    }
    return { command: 'java', args: ['-Xmx256m', '-cp', dir, 'Main'] };
  }

  private static run(
    command: string,
    args: string[],
    cwd: string,
    input: string,
    timeoutMs = env.CODE_EXEC_TIMEOUT_MS,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const child = spawn(command, args, {
        cwd,
        // A blank environment keeps credentials out of reach of submitted code.
        env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode, timedOut });
      };

      // Cap captured output so a runaway print loop cannot exhaust memory.
      const LIMIT = 256 * 1024;
      child.stdout.on('data', (d: Buffer) => {
        if (stdout.length < LIMIT) stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < LIMIT) stderr += d.toString();
      });

      child.on('error', (err) => {
        stderr += `\n${err.message}`;
        finish(-1);
      });
      child.on('close', (code) => finish(code ?? -1));

      if (input) child.stdin.write(input.endsWith('\n') ? input : `${input}\n`);
      child.stdin.end();
    });
  }
}

/**
 * Explains a compiler that failed without saying anything.
 *
 * A compiler killed by the out-of-memory killer exits non-zero with empty
 * stderr — indistinguishable, from here, from a compiler that is not installed.
 * The old wording guessed "is g++ installed?", which sent one debugging session
 * looking for a missing package that was there all along while the real cause
 * was a browser holding most of the machine's memory.
 *
 * So: only blame a missing compiler when the process could not be started at
 * all, and otherwise say what actually happened.
 */
function describeCompileFailure(
  compile: { stderr: string; exitCode: number; timedOut: boolean },
  compiler: string,
): string {
  const stderr = compile.stderr.trim();
  if (stderr) return stderr.slice(0, 4000);

  if (compile.timedOut) {
    return `The ${compiler} compiler took too long and was stopped. Try a simpler solution, or fewer headers.`;
  }

  // spawn() failure surfaces as -1 here; anything else ran and was killed.
  if (compile.exitCode === -1) {
    return `The ${compiler} compiler is not available on this server.`;
  }

  return (
    `The ${compiler} compiler was stopped before it finished (exit ${compile.exitCode}), ` +
    'most likely because the server ran out of memory. This is a server problem, not a problem with your code.'
  );
}
