import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DuetError } from '../util/errors.js';

export interface ChromeLaunchOptions {
  profileDir: string;
  executablePath?: string;
  /** Fake camera and microphone, and no permission prompt for them. */
  fakeMedia?: boolean;
  /** A .y4m or .mjpeg file the fake camera plays instead of the test pattern. */
  fakeVideo?: string;
  /**
   * Screen sharing (getDisplayMedia) picks the tab with this title without showing the picker.
   * Pair it with a tab you open yourself (see BrowserActor.newTab).
   */
  captureTitle?: string;
  windowSize?: [number, number];
  windowPosition?: [number, number];
  extraArgs?: string[];
}

export interface RunningChrome {
  pid: number;
  port: number;
  wsPath: string;
}

const CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  win32: [
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

/** The installed Chrome. duet drives the system browser rather than downloading one. */
export function findChrome(explicit?: string): string {
  const path = explicit ?? process.env.DUET_CHROME ?? CANDIDATES[process.platform]?.find((p) => existsSync(p));
  if (!path || !existsSync(path)) {
    throw new DuetError('Chrome not found. Install Google Chrome or set DUET_CHROME to its executable.', 'not-found');
  }
  return path;
}

export function chromeArgs(o: ChromeLaunchOptions): string[] {
  const [w, h] = o.windowSize ?? [1100, 860];
  const args = [
    `--user-data-dir=${resolve(o.profileDir)}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    `--window-size=${w},${h}`,
  ];
  if (o.windowPosition) args.push(`--window-position=${o.windowPosition[0]},${o.windowPosition[1]}`);
  if (o.fakeMedia || o.fakeVideo) {
    args.push('--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required');
    // --use-fake-ui-for-media-stream would also skip the screen-share picker and hand
    // getDisplayMedia a fake green test pattern, so tab selection by title never happens.
    // When a capture tab is named, only camera and microphone prompts are auto-accepted.
    args.push(o.captureTitle ? '--auto-accept-camera-and-microphone-capture' : '--use-fake-ui-for-media-stream');
  }
  if (o.fakeVideo) args.push(`--use-file-for-fake-video-capture=${resolve(o.fakeVideo)}`);
  if (o.captureTitle) args.push(`--auto-select-tab-capture-source-by-title=${o.captureTitle}`);
  args.push(...(o.extraArgs ?? []), 'about:blank');
  return args;
}

/**
 * Starts Chrome detached, so it outlives the command that started it, and waits for its
 * DevTools port. Later commands attach to it by port.
 */
export async function launchChrome(o: ChromeLaunchOptions, timeoutMs = 20_000): Promise<RunningChrome> {
  const exe = findChrome(o.executablePath);
  mkdirSync(o.profileDir, { recursive: true });
  const portFile = join(o.profileDir, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  const child = spawn(exe, chromeArgs(o), { detached: true, stdio: 'ignore' });
  child.unref();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new DuetError(
        `Chrome exited at once (code ${child.exitCode}). Another Chrome may already be using the profile ${o.profileDir}; close it first.`,
        'failed',
      );
    }
    if (existsSync(portFile)) {
      const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n');
      if (port && wsPath) return { pid: child.pid!, port: Number(port), wsPath };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(child.pid!);
  } catch {}
  throw new DuetError(`Chrome did not open its DevTools port within ${timeoutMs} ms.`, 'timeout');
}

/** Whether a Chrome we started earlier is still answering on its port. */
export async function isAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
