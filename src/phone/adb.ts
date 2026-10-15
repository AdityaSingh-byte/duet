import { DuetError } from '../util/errors.js';
import { run as defaultRunner, type ExecOptions, type ExecResult, type Runner } from '../util/exec.js';
import { parseDevices, type DeviceInfo } from './parse.js';

/** Quotes one argument for the device's /system/bin/sh. */
export function shQuote(arg: string): string {
  if (arg !== '' && /^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface AdbOptions {
  serial?: string;
  adbPath?: string;
  runner?: Runner;
  timeoutMs?: number;
}

/**
 * A thin wrapper over the adb binary, pinned to one device.
 * `adb shell` joins its arguments with spaces and hands them to the device shell,
 * so every argument is quoted here instead of trusting adb to do it.
 */
export class Adb {
  readonly serial: string | undefined;
  private readonly adbPath: string;
  private readonly runner: Runner;
  private readonly timeoutMs: number;

  constructor(opts: AdbOptions = {}) {
    this.serial = opts.serial;
    this.adbPath = opts.adbPath ?? process.env.DUET_ADB ?? 'adb';
    this.runner = opts.runner ?? defaultRunner;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Runs `adb [-s serial] <args>` and returns the raw result. */
  async raw(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const full = this.serial ? ['-s', this.serial, ...args] : args;
    try {
      return await this.runner(this.adbPath, full, { timeoutMs: this.timeoutMs, ...opts });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        throw new DuetError(
          `adb not found ("${this.adbPath}"). Install Android platform-tools or set DUET_ADB to its path.`,
          'device',
        );
      }
      throw e;
    }
  }

  /** Runs a command on the device with every argument quoted. Throws on a non-zero exit. */
  async shell(args: string[], opts: ExecOptions & { allowFail?: boolean } = {}): Promise<string> {
    return this.shellRaw(args.map(shQuote).join(' '), opts);
  }

  /**
   * Runs a device shell command line as written, for fixed pipelines such as `dumpsys window | grep ...`.
   * Never pass untrusted text here; use shell() for that.
   */
  async shellRaw(cmdline: string, opts: ExecOptions & { allowFail?: boolean } = {}): Promise<string> {
    const res = await this.raw(['shell', cmdline], opts);
    if (res.code !== 0 && !opts.allowFail) {
      throw this.failure(`adb shell ${cmdline}`, res);
    }
    return res.stdout.toString('utf8');
  }

  /** `adb exec-out`: binary-safe stdout (used for screencap and file reads). */
  async execOut(args: string[], opts: ExecOptions = {}): Promise<Buffer> {
    const res = await this.raw(['exec-out', args.map(shQuote).join(' ')], opts);
    if (res.code !== 0) throw this.failure(`adb exec-out ${args.join(' ')}`, res);
    return res.stdout;
  }

  failure(what: string, res: ExecResult): DuetError {
    const text = `${res.stderr}\n${res.stdout.toString('utf8')}`.trim();
    if (/no devices\/emulators found|device '.*' not found|device offline|unauthorized/i.test(text)) {
      return new DuetError(`${what}: ${firstLine(text)}. Check the cable and run "duet phone devices".`, 'device');
    }
    if (/more than one device/i.test(text)) {
      return new DuetError('More than one device is connected. Pass --serial or set ANDROID_SERIAL.', 'device');
    }
    return new DuetError(`${what} failed (exit ${res.code}): ${firstLine(text) || 'no output'}`, 'failed', {
      output: text.slice(0, 2000),
    });
  }
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim())?.trim() ?? '';
}

export async function listDevices(opts: AdbOptions = {}): Promise<DeviceInfo[]> {
  const adb = new Adb({ ...opts, serial: undefined });
  const res = await adb.raw(['devices', '-l']);
  if (res.code !== 0) throw adb.failure('adb devices', res);
  return parseDevices(res.stdout.toString('utf8'));
}

/**
 * Picks the device to drive: an explicit serial, then ANDROID_SERIAL, then the only connected device.
 * Refuses to guess when several are connected.
 */
export async function resolveSerial(explicit: string | undefined, opts: AdbOptions = {}): Promise<string> {
  const wanted = explicit ?? process.env.ANDROID_SERIAL;
  const devices = await listDevices(opts);
  const ready = devices.filter((d) => d.state === 'device');
  if (wanted) {
    const found = devices.find((d) => d.serial === wanted);
    if (!found) throw new DuetError(`Device ${wanted} is not connected.`, 'device', { devices });
    if (found.state !== 'device') {
      throw new DuetError(`Device ${wanted} is ${found.state}. Unlock it and accept the USB debugging prompt.`, 'device');
    }
    return wanted;
  }
  if (ready.length === 1) return ready[0]!.serial;
  if (ready.length === 0) {
    const hint = devices.length ? ` (${devices.map((d) => `${d.serial}: ${d.state}`).join(', ')})` : '';
    throw new DuetError(`No Android device is ready${hint}. Connect one with USB debugging on.`, 'device');
  }
  throw new DuetError(
    `${ready.length} devices are connected. Pass --serial or set ANDROID_SERIAL to one of: ${ready.map((d) => d.serial).join(', ')}`,
    'device',
  );
}
