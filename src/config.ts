import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DuetError } from './util/errors.js';

export interface DuetConfig {
  /** Where steps, screenshots and logs go. Default .duet/run */
  runDir?: string;
  phone?: {
    serial?: string;
    /** App(s) under test. The first one is the default for launch and open-link. */
    packages?: string[];
    /** Longest edge of saved screenshots, in pixels. Default 1568. */
    maxEdge?: number;
    /** Pause before a follow-up screenshot (--shot), in ms. Default 600. */
    settleMs?: number;
  };
}

/**
 * duet.config.json (shared, committed) merged with duet.config.local.json (this machine: serial, paths; gitignored).
 */
export function loadConfig(cwd = process.cwd()): DuetConfig {
  const merged: DuetConfig = {};
  for (const name of ['duet.config.json', 'duet.config.local.json']) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    let cfg: DuetConfig;
    try {
      cfg = JSON.parse(readFileSync(path, 'utf8')) as DuetConfig;
    } catch (e) {
      throw new DuetError(`${name} is not valid JSON: ${(e as Error).message}`, 'usage');
    }
    merged.runDir = cfg.runDir ?? merged.runDir;
    merged.phone = { ...merged.phone, ...cfg.phone };
  }
  return merged;
}
