import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** One step any actor took, as written to events.jsonl. The HTML report is built from these. */
export interface RunEvent {
  t: string;
  actor: string;
  action: string;
  args?: Record<string, unknown>;
  ok: boolean;
  /** Paths relative to the run folder. */
  shot?: string;
  log?: string;
  result?: unknown;
  error?: string;
  ms?: number;
}

/**
 * A run folder: events.jsonl (every step), shots/, logs/ and state.json
 * (things one CLI call leaves for the next, such as the last screenshot's scale).
 */
export class RunDir {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'shots'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
  }

  static fromEnv(explicit?: string): RunDir {
    return new RunDir(explicit ?? process.env.DUET_RUN_DIR ?? join('.duet', 'run'));
  }

  record(ev: Omit<RunEvent, 't'>): RunEvent {
    const full: RunEvent = { t: new Date().toISOString(), ...ev };
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(full) + '\n');
    return full;
  }

  events(): RunEvent[] {
    try {
      return readFileSync(join(this.dir, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RunEvent);
    } catch {
      return [];
    }
  }

  /** Next numbered file in a subfolder, e.g. shots/007-phone-after-tap.png */
  nextPath(sub: 'shots' | 'logs', actor: string, label: string | undefined, ext: string): string {
    const n = readdirSync(join(this.dir, sub)).length + 1;
    const slug = [actor, label].filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return join(this.dir, sub, `${String(n).padStart(3, '0')}-${slug || actor}.${ext}`);
  }

  rel(path: string): string {
    return relative(this.dir, path);
  }

  state<T = Record<string, unknown>>(): T {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'state.json'), 'utf8')) as T;
    } catch {
      return {} as T;
    }
  }

  setState(patch: Record<string, unknown>): void {
    writeFileSync(join(this.dir, 'state.json'), JSON.stringify({ ...this.state(), ...patch }, null, 2));
  }

  write(path: string, data: Buffer | string): void {
    writeFileSync(path, data);
  }
}
