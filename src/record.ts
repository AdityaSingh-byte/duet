import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { ScreenRecorder } from 'puppeteer-core';
import type { BrowserActor } from './browser/browser.js';
import type { Phone } from './phone/phone.js';
import type { RunDir } from './run.js';
import { DuetError } from './util/errors.js';

/** One actor's recording, with the wall-clock time it started so tracks can be lined up. */
export interface Track {
  actor: string;
  kind: 'phone' | 'browser';
  path: string;
  startedAt: number;
}

/**
 * Records a phone's screen with Android's own `screenrecord` (no extra tools on the phone).
 * Android stops it after 3 minutes. It records whatever is on screen, so it only starts
 * when the guard says the app under test or the home screen is in front.
 */
export class PhoneRecorder {
  private constructor(
    private readonly phone: Phone,
    private readonly proc: ChildProcess,
    private readonly remote: string,
    readonly startedAt: number,
  ) {}

  static async start(phone: Phone): Promise<PhoneRecorder> {
    const { verdict } = await phone.guard('observe');
    if (!verdict.ok) throw new DuetError(`Not recording ${phone.name}: ${verdict.reasons.join('; ')}.`, 'guard');
    const remote = `/data/local/tmp/duet-rec-${phone.name}.mp4`;
    const adbPath = process.env.DUET_ADB ?? 'adb';
    const proc = spawn(adbPath, ['-s', phone.adb.serial ?? '', 'shell', 'screenrecord', '--bit-rate', '8000000', '--time-limit', '180', remote], {
      stdio: 'ignore',
    });
    const startedAt = Date.now();
    await new Promise((r) => setTimeout(r, 400));
    if (proc.exitCode !== null) throw new DuetError('screenrecord exited at once; this device may not allow it.', 'failed');
    return new PhoneRecorder(phone, proc, remote, startedAt);
  }

  /** Stops the recording (SIGINT lets screenrecord finish the file), pulls it, and deletes it from the phone. */
  async stop(run: RunDir): Promise<Track> {
    await this.phone.adb.shell(['pkill', '-INT', 'screenrecord'], { allowFail: true });
    await new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null) return resolve();
      const t = setTimeout(() => {
        this.proc.kill();
        resolve();
      }, 10_000);
      this.proc.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    // screenrecord needs a moment after exit before the file is complete on some devices.
    await new Promise((r) => setTimeout(r, 500));
    const path = join(run.dir, 'video', `${this.phone.name}.mp4`);
    const res = await this.phone.adb.raw(['pull', this.remote, path], { timeoutMs: 120_000 });
    if (res.code !== 0) throw this.phone.adb.failure('adb pull', res);
    await this.phone.adb.shell(['rm', '-f', this.remote], { allowFail: true });
    return { actor: this.phone.name, kind: 'phone', path, startedAt: this.startedAt };
  }
}

/** Records a browser actor's page through Chrome's screencast (needs ffmpeg on PATH). */
export class BrowserRecorder {
  private constructor(
    private readonly actor: BrowserActor,
    private readonly recorder: ScreenRecorder,
    private readonly path: string,
    readonly startedAt: number,
  ) {}

  static async start(actor: BrowserActor, run: RunDir): Promise<BrowserRecorder> {
    const path = join(run.dir, 'video', `${actor.name}.webm`) as `${string}.webm`;
    // Chrome's screencast only sends a frame when the page changes, so a page that sits still
    // records nothing at all. A 2 px, nearly transparent element that moves once a second keeps
    // frames coming without changing what anyone sees.
    const heartbeat = `(() => {
      const add = () => {
        if (document.getElementById('__duet_heartbeat')) return;
        const el = document.createElement('div');
        el.id = '__duet_heartbeat';
        el.setAttribute('aria-hidden', 'true');
        el.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;background:#000;opacity:0.02;pointer-events:none;z-index:2147483647';
        document.documentElement.appendChild(el);
        el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-1px)' }], { duration: 1000, iterations: Infinity, direction: 'alternate' });
      };
      if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
    })()`;
    await actor.page.evaluateOnNewDocument(heartbeat).catch(() => {});
    await actor.page.evaluate(heartbeat).catch(() => {});
    try {
      const recorder = await actor.page.screencast({ path });
      return new BrowserRecorder(actor, recorder, path, Date.now());
    } catch (e) {
      throw new DuetError(`Could not record ${actor.name}: ${(e as Error).message}. Recording a browser needs ffmpeg on PATH.`, 'failed');
    }
  }

  async stop(): Promise<Track> {
    await this.recorder.stop();
    return { actor: this.actor.name, kind: 'browser', path: this.path, startedAt: this.startedAt };
  }
}
