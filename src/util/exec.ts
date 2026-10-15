import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Runs a program and collects its output. Never throws on a non-zero exit; callers decide. */
export type Runner = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const run: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    }
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8');
      resolve({
        code: code ?? (signal ? 124 : 1),
        stdout: Buffer.concat(out),
        stderr: signal && opts.timeoutMs ? `${stderr}\ntimed out after ${opts.timeoutMs} ms` : stderr,
      });
    });
  });
