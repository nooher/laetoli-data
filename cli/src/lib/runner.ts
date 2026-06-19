// runner.ts — a thin, injectable wrapper around child_process so shelling-out
// commands (docker, pg_dump, psql) can be unit-tested without spawning anything.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** When true, inherit stdio so the child streams directly to the terminal. */
  inherit?: boolean;
  /** Extra env on top of process.env. */
  env?: Record<string, string>;
  /** Optional stdin to pipe to the child (used by restore). */
  input?: string;
}

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** The real runner — spawns a child process. */
export const realRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: opts.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    if (!opts.inherit) {
      child.stdout?.on('data', (d) => (stdout += d.toString()));
      child.stderr?.on('data', (d) => (stderr += d.toString()));
    }
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });

/**
 * Locate the `docker` executable. On this dev (Windows) machine Docker Desktop
 * installs to a fixed path that may not be on PATH; detect it. Otherwise assume
 * `docker` resolves via PATH (the normal case on Linux/Pi/CI).
 */
export function dockerCommand(): string {
  const candidates = [
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
    '/usr/bin/docker',
    '/usr/local/bin/docker',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'docker'; // rely on PATH
}
