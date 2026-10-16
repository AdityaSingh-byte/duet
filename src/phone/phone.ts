import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { RunDir } from '../run.js';
import { DuetError } from '../util/errors.js';
import { run as defaultRunner, type Runner } from '../util/exec.js';
import { darkFraction, downscalePng, pngSize } from '../util/png.js';
import { Adb, resolveSerial, shQuote } from './adb.js';
import { evaluateGuard, type ActionKind, type GuardPolicy, type GuardVerdict, type PhoneStatus } from './guard.js';
import {
  parseFocus,
  parseKeyguard,
  parseInjectionFailure,
  parsePids,
  parseResolvedPackage,
  parseRotation,
  parseTopActivity,
  parseWakefulness,
  parseStuckPointers,
  parseWmSize,
  type Rotation,
  type StuckPointers,
} from './parse.js';
import { center, findByText, parseUiDump, summarize, type FindOptions, type UiNode } from './ui.js';

export interface PhoneOptions {
  /** Actor name in the run record. Default "phone". */
  name?: string;
  serial?: string;
  /** Packages under test; taps and typing only happen while one of them is in front. */
  packages?: string[];
  /** Skip the safety guard. For a dedicated lab device only. */
  noGuard?: boolean;
  /** Longest edge of saved screenshots. Keep it at or under what your model sees unscaled. */
  maxEdge?: number;
  /** Pause after an action before a follow-up screenshot. */
  settleMs?: number;
  run?: RunDir;
  runner?: Runner;
  adbPath?: string;
}

export interface Shot {
  path: string;
  image: [number, number];
  device: [number, number];
  /** Multiply image coordinates by this to get device pixels. */
  scale: number;
  rotation: Rotation | null;
  warning?: string;
}

export interface LastShot extends Shot {
  takenAt: string;
}

export type TapTarget =
  | { x: number; y: number; space?: 'image' | 'device' }
  | ({ text: string; index?: number } & FindOptions);

export interface ResignOptions {
  keystore?: string;
  /** apksigner password spec: pass:<pw>, env:<VAR> or file:<path>. Defaults to the debug keystore's. */
  storePass?: string;
  keyPass?: string;
  alias?: string;
}

const WINDOW_FIELDS = 'isKeyguardShowing|KeyguardShowing|mShowingLockscreen|mDreamingLockscreen|isStatusBarKeyguard|mCurrentFocus=|mRotation=|mCurrentRotation=|mGlobalConfiguration=';
const DUMP_PATH = '/data/local/tmp/duet-ui.xml';
const UNSTICK_PATH = '/data/local/tmp/duet-unstick.dex';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One Android device, driven over adb, with every step recorded to the run folder. */
export class Phone {
  readonly adb: Adb;
  readonly run: RunDir;
  readonly policy: GuardPolicy;
  readonly name: string;
  private readonly noGuard: boolean;
  private readonly maxEdge: number;
  private readonly settleMs: number;
  private readonly runner: Runner;
  private home: string | null | undefined;

  constructor(adb: Adb, opts: PhoneOptions = {}) {
    this.adb = adb;
    this.run = opts.run ?? RunDir.fromEnv();
    this.policy = { packages: opts.packages ?? [] };
    this.name = opts.name ?? 'phone';
    this.noGuard = opts.noGuard ?? false;
    this.maxEdge = opts.maxEdge ?? 1568;
    this.settleMs = opts.settleMs ?? 600;
    this.runner = opts.runner ?? defaultRunner;
  }

  /** Picks the device (explicit serial, ANDROID_SERIAL, or the only one connected) and returns a Phone for it. */
  static async connect(opts: PhoneOptions = {}): Promise<Phone> {
    const serial = await resolveSerial(opts.serial, { runner: opts.runner, adbPath: opts.adbPath });
    return new Phone(new Adb({ serial, runner: opts.runner, adbPath: opts.adbPath }), opts);
  }

  // ---- status and guard ---------------------------------------------------

  async status(): Promise<PhoneStatus> {
    const [win, act, power, home] = await Promise.all([
      this.adb.shellRaw(`dumpsys window | grep -E '${WINDOW_FIELDS}' | grep -v -i snapshot`, { allowFail: true }),
      this.adb.shellRaw(`dumpsys activity activities | grep -E 'ResumedActivity|KeyguardShowing'`, { allowFail: true }),
      this.adb.shellRaw(`dumpsys power | grep -E 'mWakefulness='`, { allowFail: true }),
      this.homePackage(),
    ]);
    return {
      wakefulness: parseWakefulness(power),
      locked: parseKeyguard(`${win}\n${act}`),
      foreground: parseTopActivity(act),
      focus: parseFocus(win),
      home,
      rotation: parseRotation(win),
    };
  }

  async homePackage(): Promise<string | null> {
    if (this.home === undefined) {
      const out = await this.adb.shell(
        ['cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME'],
        { allowFail: true },
      );
      this.home = parseResolvedPackage(out);
    }
    return this.home;
  }

  async guard(kind: ActionKind = 'act'): Promise<{ status: PhoneStatus; verdict: GuardVerdict }> {
    const status = await this.status();
    return { status, verdict: evaluateGuard(status, this.policy, kind) };
  }

  /** Throws a guard error unless the action is safe right now. Returns the status it read. */
  private async ensureSafe(kind: ActionKind, action: string): Promise<PhoneStatus> {
    const { status, verdict } = await this.guard(kind);
    if (!verdict.ok && !this.noGuard) {
      throw new DuetError(`Not doing "${action}": ${verdict.reasons.join('; ')}.`, 'guard', { status });
    }
    return status;
  }

  // ---- observe ------------------------------------------------------------

  async screenshot(opts: { label?: string; maxEdge?: number } = {}): Promise<Shot> {
    return this.step('screenshot', { label: opts.label }, async () => {
      const status = await this.ensureSafe('observe', 'screenshot');
      const raw = await this.adb.execOut(['screencap', '-p']);
      const device = pngSize(raw);
      const scaled = downscalePng(raw, opts.maxEdge ?? this.maxEdge);
      const path = this.run.nextPath('shots', this.name, opts.label, 'png');
      this.run.write(path, scaled.png);
      const shot: Shot = {
        path,
        image: [scaled.width, scaled.height],
        device: [device.width, device.height],
        scale: Number((device.width / scaled.width).toFixed(4)),
        rotation: status.rotation,
      };
      if (darkFraction(scaled.png) > 0.97) {
        shot.warning = 'The screenshot is almost all black: the screen may be off or locked, or the app blocks screenshots (FLAG_SECURE).';
      }
      this.run.setState({ lastShot: { ...shot, takenAt: new Date().toISOString() } satisfies LastShot });
      return { result: shot, shot: path };
    });
  }

  /** The uiautomator element tree of the current screen. */
  async ui(): Promise<UiNode[]> {
    await this.ensureSafe('observe', 'read the screen');
    return this.dumpUi();
  }

  async uiSummary(opts: { all?: boolean } = {}): Promise<string[]> {
    return this.step('ui', opts, async () => ({ result: summarize(await this.ui(), opts) }));
  }

  private async dumpUi(): Promise<UiNode[]> {
    const res = await this.adb.raw(['shell', `uiautomator dump ${DUMP_PATH}`], { timeoutMs: 20_000 });
    const out = `${res.stdout.toString('utf8')}\n${res.stderr}`.trim();
    if (res.code !== 0 || /ERROR|Exception/.test(out) || !/dumped to/i.test(out)) {
      throw new DuetError(
        `uiautomator could not read the screen (${out.split('\n')[0] || `exit ${res.code}`}). ` +
          'This happens when the screen never goes idle (live video, endless animation) or another tool such as Maestro holds uiautomator. ' +
          'Take a screenshot and tap by coordinates instead.',
        'failed',
      );
    }
    const xml = (await this.adb.execOut(['cat', DUMP_PATH])).toString('utf8');
    await this.adb.shell(['rm', '-f', DUMP_PATH], { allowFail: true });
    return parseUiDump(xml);
  }

  /** Polls the element tree until an element matching `text` appears (or is gone). */
  async waitFor(q: { text: string; gone?: boolean; timeoutMs?: number; intervalMs?: number } & FindOptions): Promise<{ found: string | null; ms: number }> {
    return this.step('wait-for', { ...q }, async () => {
      const started = Date.now();
      const timeout = q.timeoutMs ?? 10_000;
      let lastError: unknown;
      for (;;) {
        await this.ensureSafe('observe', 'wait for the screen');
        try {
          const hit = findByText(await this.dumpUi(), q.text, q)[0];
          if (q.gone ? !hit : hit) {
            return { result: { found: hit ? hit.text || hit.desc : null, ms: Date.now() - started } };
          }
          lastError = undefined;
        } catch (e) {
          lastError = e;
        }
        if (Date.now() - started > timeout) {
          if (lastError) throw lastError;
          throw new DuetError(`"${q.text}" ${q.gone ? 'is still on screen' : 'did not appear'} after ${timeout} ms.`, 'timeout');
        }
        await pause(q.intervalMs ?? 400);
      }
    });
  }

  async rotation(): Promise<{ rotation: Rotation; degrees: number; landscape: boolean }> {
    return this.step('rotation', {}, async () => ({ result: await this.readRotation() }));
  }

  private async readRotation(): Promise<{ rotation: Rotation; degrees: number; landscape: boolean }> {
    const [win, size] = await Promise.all([
      this.adb.shellRaw(`dumpsys window | grep -E 'mRotation=|mCurrentRotation=|mGlobalConfiguration=' | grep -v -i snapshot`, { allowFail: true }),
      this.adb.shell(['wm', 'size']),
    ]);
    const rotation = parseRotation(win);
    if (rotation === null) throw new DuetError('Could not read the display rotation from dumpsys window.', 'failed');
    const phys = parseWmSize(size)?.physical;
    const naturalPortrait = phys ? phys[1] >= phys[0] : true;
    return { rotation, degrees: rotation * 90, landscape: (rotation % 2 === 1) === naturalPortrait };
  }

  /**
   * Polls the rotation until it matches, for checks like "the phone turned sideways".
   * Fails with the last reading after the timeout.
   */
  async expectRotation(want: 'landscape' | 'portrait', timeoutMs = 0): Promise<{ rotation: Rotation; degrees: number; landscape: boolean; ms: number }> {
    return this.step('rotation', { expect: want, timeoutMs }, async () => {
      const started = Date.now();
      for (;;) {
        const r = await this.readRotation();
        if ((want === 'landscape') === r.landscape) return { result: { ...r, ms: Date.now() - started } };
        if (Date.now() - started >= timeoutMs) {
          throw new DuetError(`Expected ${want}, but the phone is ${r.landscape ? 'landscape' : 'portrait'} (${r.degrees} degrees).`, 'failed', r);
        }
        await pause(250);
      }
    });
  }

  /** Lets the phone reach a port on this computer as localhost (adb reverse). Touches nothing on screen. */
  async reverse(port: number, devicePort = port): Promise<{ device: string; host: string }> {
    return this.step('reverse', { port, devicePort }, async () => {
      const res = await this.adb.raw(['reverse', `tcp:${devicePort}`, `tcp:${port}`]);
      if (res.code !== 0) throw this.adb.failure('adb reverse', res);
      return { result: { device: `localhost:${devicePort}`, host: `localhost:${port}` } };
    });
  }

  // ---- act ----------------------------------------------------------------

  async tap(target: TapTarget, opts: { shot?: boolean; label?: string } = {}): Promise<{ x: number; y: number; matched?: string; candidates?: number; shot?: Shot }> {
    return this.step('tap', { ...target }, async () => {
      const status = await this.ensureSafe('act', 'tap');
      let point: { x: number; y: number };
      let matched: string | undefined;
      let candidates: number | undefined;
      if ('text' in target) {
        const nodes = await this.dumpUi();
        const hits = findByText(nodes, target.text, target);
        const pick = hits[target.index ?? 0];
        if (!pick) {
          const onScreen = summarize(nodes).slice(0, 40);
          throw new DuetError(
            hits.length ? `Only ${hits.length} element(s) match "${target.text}"; index ${target.index} is out of range.` : `No element matches "${target.text}".`,
            'not-found',
            { onScreen },
          );
        }
        point = center(pick.bounds);
        matched = pick.text || pick.desc;
        candidates = hits.length;
      } else {
        point = this.toDevice(target, status.rotation);
      }
      await this.inject(['tap', String(point.x), String(point.y)]);
      const result: { x: number; y: number; matched?: string; candidates?: number; shot?: Shot } = { ...point, matched, candidates };
      if (opts.shot) result.shot = await this.settleAndShoot(opts.label ?? 'after-tap');
      return { result };
    });
  }

  async swipe(from: { x: number; y: number }, to: { x: number; y: number }, opts: { ms?: number; space?: 'image' | 'device'; shot?: boolean } = {}) {
    return this.step('swipe', { from, to, ...opts }, async () => {
      const status = await this.ensureSafe('act', 'swipe');
      const a = this.toDevice({ ...from, space: opts.space }, status.rotation);
      const b = this.toDevice({ ...to, space: opts.space }, status.rotation);
      await this.inject(['swipe', String(a.x), String(a.y), String(b.x), String(b.y), String(opts.ms ?? 300)]);
      const result: { from: typeof a; to: typeof b; shot?: Shot } = { from: a, to: b };
      if (opts.shot) result.shot = await this.settleAndShoot('after-swipe');
      return { result };
    });
  }

  /** Types into the focused field. ASCII only: `input text` cannot type other characters. */
  async type(text: string, opts: { shot?: boolean } = {}) {
    return this.step('type', { length: text.length }, async () => {
      if (/[^\x20-\x7e]/.test(text)) {
        throw new DuetError('input text can only type printable ASCII. Paste other text through the app under test instead.', 'usage');
      }
      await this.ensureSafe('act', 'type');
      await this.inject(['text', text.replace(/ /g, '%s')]);
      return { result: { typed: text.length, shot: opts.shot ? await this.settleAndShoot('after-type') : undefined } };
    });
  }

  async key(code: string, opts: { shot?: boolean } = {}) {
    const keycode = /^\d+$/.test(code) || code.startsWith('KEYCODE_') ? code : `KEYCODE_${code.toUpperCase()}`;
    return this.step('key', { keycode }, async () => {
      await this.ensureSafe('act', keycode);
      await this.inject(['keyevent', keycode]);
      return { result: { keycode, shot: opts.shot ? await this.settleAndShoot(`after-${keycode.toLowerCase()}`) : undefined } };
    });
  }

  back(opts: { shot?: boolean } = {}) {
    return this.key('KEYCODE_BACK', opts);
  }

  /** Opens a URI (deep link or web link) with a VIEW intent, optionally pinned to a package. */
  async openLink(uri: string, opts: { package?: string; shot?: boolean } = {}) {
    return this.step('open-link', { uri, package: opts.package }, async () => {
      await this.ensureSafe('launch', 'open a link');
      const args = ['am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', uri];
      const pkg = opts.package ?? this.policy.packages[0];
      if (pkg) args.push(pkg);
      const out = await this.adb.shell(args, { allowFail: true });
      if (/Error:|Exception|unable to resolve/i.test(out)) {
        throw new DuetError(`The link did not open: ${out.trim().split('\n').find((l) => /Error|Exception/i.test(l)) ?? out.trim()}`, 'failed');
      }
      return { result: { opened: uri, package: pkg ?? null, shot: opts.shot ? await this.settleAndShoot('after-link') : undefined } };
    });
  }

  /** Starts the app's launcher activity. */
  async launch(opts: { package?: string; shot?: boolean } = {}) {
    const pkg = opts.package ?? this.policy.packages[0];
    return this.step('launch', { package: pkg }, async () => {
      if (!pkg) throw new DuetError('No package to launch. Pass --package or set phone.packages in duet.config.json.', 'usage');
      await this.ensureSafe('launch', `launch ${pkg}`);
      const out = await this.adb.shell(['cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', pkg], {
        allowFail: true,
      });
      const component = out.trim().split('\n').pop()?.trim() ?? '';
      if (parseResolvedPackage(out) !== pkg) throw new DuetError(`${pkg} is not installed or has no launcher activity.`, 'not-found');
      await this.adb.shell(['am', 'start', '-W', '-n', component]);
      return { result: { launched: component, shot: opts.shot ? await this.settleAndShoot('after-launch') : undefined } };
    });
  }

  /**
   * Runs `adb shell input ...` and, in the same call, reads what the input dispatcher said about it.
   * `input` exits 0 even when Android rejects the event, so without this a tap that never
   * happened would be reported as done.
   */
  private async inject(args: string[]): Promise<void> {
    const cmd = `t=$(date +%s.%N | cut -c1-14); input ${args.map(shQuote).join(' ')}; logcat -d -v brief -T "$t" | grep -E 'Inconsistent event|injection from pid [0-9]+ failed'`;
    const out = await this.adb.shellRaw(cmd, { allowFail: true });
    const reason = parseInjectionFailure(out);
    if (!reason) return;
    const stuck = parseStuckPointers(out);
    const hint =
      stuck && Object.keys(stuck).length
        ? ' Another tool left a touch pressed and never released it. Run "duet phone unstick" to release it, then try again.'
        : '';
    throw new DuetError(`Android rejected the injected input (${reason}).${hint}`, 'failed', { stuck });
  }

  /**
   * Releases injected touch pointers that another tool pressed and never let go (for example an
   * automation run killed mid-gesture). Until they are released Android rejects every injected tap.
   * Sends ACTION_CANCEL for exactly those pointer ids, through a small helper run with app_process.
   */
  async unstick(): Promise<{ stuck: StuckPointers; released: boolean }> {
    return this.step('unstick', {}, async () => {
      await this.ensureSafe('launch', 'release stuck touches');
      const probe = async () =>
        parseStuckPointers(
          await this.adb.shellRaw(
            `t=$(date +%s.%N | cut -c1-14); input motionevent CANCEL 1 1; logcat -d -v brief -T "$t" | grep -E 'Existing pointers|pointers already down|Touching pointers'`,
            { allowFail: true },
          ),
        );
      const stuck = await probe();
      if (stuck === null) throw new DuetError('Could not read the injected-touch state from the device log on this Android version.', 'failed');
      if (!Object.keys(stuck).length) return { result: { stuck, released: true } };
      const dex = new URL('../../assets/duet-unstick.dex', import.meta.url).pathname;
      if (!existsSync(dex)) throw new DuetError(`${dex} is missing. Build it with scripts/build-unstick.sh.`, 'not-found');
      const push = await this.adb.raw(['push', dex, UNSTICK_PATH]);
      if (push.code !== 0) throw this.adb.failure('adb push', push);
      for (const [device, ids] of Object.entries(stuck)) {
        await this.adb.shellRaw(`CLASSPATH=${UNSTICK_PATH} app_process / Unstick ${Number(device)} ${ids.map(Number).join(' ')}`);
      }
      const after = await probe();
      const released = !!after && Object.keys(after).length === 0;
      if (!released) throw new DuetError(`Touches are still stuck after the release: ${JSON.stringify(after)}.`, 'failed', { before: stuck, after });
      return { result: { stuck, released } };
    });
  }

  private async settleAndShoot(label: string): Promise<Shot> {
    await pause(this.settleMs);
    return this.screenshot({ label });
  }

  /** Converts a point from the last screenshot's image space (the default) to device pixels. */
  private toDevice(p: { x: number; y: number; space?: 'image' | 'device' }, rotationNow: Rotation | null): { x: number; y: number } {
    if (p.space === 'device') return { x: Math.round(p.x), y: Math.round(p.y) };
    const last = this.run.state<{ lastShot?: LastShot }>().lastShot;
    if (!last) {
      throw new DuetError('No screenshot yet in this run, so image coordinates mean nothing. Take one first, or pass --device for raw pixels.', 'usage');
    }
    if (last.rotation !== null && rotationNow !== null && last.rotation !== rotationNow) {
      throw new DuetError(
        `The screen rotated since the last screenshot (${last.rotation * 90} -> ${rotationNow * 90} degrees). Take a new screenshot before tapping.`,
        'usage',
      );
    }
    if (p.x < 0 || p.y < 0 || p.x > last.image[0] || p.y > last.image[1]) {
      throw new DuetError(`(${p.x}, ${p.y}) is outside the last screenshot (${last.image[0]}x${last.image[1]}).`, 'usage');
    }
    return {
      x: Math.min(last.device[0] - 1, Math.round(p.x * last.scale)),
      y: Math.min(last.device[1] - 1, Math.round(p.y * last.scale)),
    };
  }

  // ---- logs ---------------------------------------------------------------

  /** Remembers "now" on the device clock, so a later logs() call returns only what came after. */
  async markLogs(): Promise<{ mark: string }> {
    return this.step('logs-mark', {}, async () => {
      const raw = (await this.adb.shell(['date', '+%s.%N'])).trim();
      const mark = /^\d+\.\d{3,}$/.test(raw) ? raw.replace(/^(\d+\.\d{3})\d*$/, '$1') : `${raw.split('.')[0]}.000`;
      if (!/^\d+\.\d{3}$/.test(mark)) throw new DuetError(`Unexpected device clock output: ${raw}`, 'failed');
      this.run.setState({ logMark: mark });
      return { result: { mark } };
    });
  }

  /**
   * Reads logcat (without clearing it), optionally since the last mark, for one app, filtered by a regex.
   * The full capture is saved to the run folder; the returned lines are the last `max` matches.
   */
  async logs(opts: { sinceMark?: boolean; since?: string; grep?: string; app?: string | boolean; max?: number; label?: string } = {}) {
    return this.step('logs', { ...opts }, async () => {
      const args = ['-d', '-v', 'threadtime'];
      const since = opts.since ?? (opts.sinceMark ? this.run.state<{ logMark?: string }>().logMark : undefined);
      if (opts.sinceMark && !since) throw new DuetError('No log mark yet. Run "duet phone logs mark" before the action.', 'usage');
      if (since) args.push('-T', since);
      const appPkg = opts.app === true ? this.policy.packages[0] : opts.app || undefined;
      if (appPkg) {
        const pids = parsePids(await this.adb.shell(['pidof', appPkg], { allowFail: true }));
        if (!pids.length) throw new DuetError(`${appPkg} is not running, so there is no process to filter its logs by.`, 'not-found');
        args.push(`--pid=${pids[0]}`);
      }
      const res = await this.adb.raw(['logcat', ...args], { timeoutMs: 60_000 });
      if (res.code !== 0) throw this.adb.failure('adb logcat', res);
      const text = res.stdout.toString('utf8');
      const path = this.run.nextPath('logs', this.name, opts.label ?? 'logcat', 'txt');
      this.run.write(path, text);
      const all = text.split('\n').filter((l) => l && !l.startsWith('--------- beginning of'));
      const re = opts.grep ? new RegExp(opts.grep, 'i') : null;
      const matched = re ? all.filter((l) => re.test(l)) : all;
      const max = opts.max ?? 200;
      return {
        result: { path, total: all.length, matched: matched.length, lines: matched.slice(-max), truncated: matched.length > max },
        log: path,
      };
    });
  }

  // ---- install ------------------------------------------------------------

  /**
   * Installs an APK over the existing app, keeping its data (`adb install -r`).
   * With `resign`, re-signs it first with the keystore the installed copy was signed with,
   * so a release build can replace a debug install without losing sign-in.
   * Never uninstalls: that would wipe the app's data on someone's phone.
   */
  async install(apk: string, opts: { resign?: ResignOptions | boolean; downgrade?: boolean } = {}) {
    const resign = opts.resign === true ? {} : opts.resign || undefined;
    return this.step('install', { apk: basename(apk), resign: !!resign, keystore: resign?.keystore ? basename(resign.keystore) : undefined }, async () => {
      if (!existsSync(apk)) throw new DuetError(`${apk} does not exist.`, 'not-found');
      let file = apk;
      if (resign) file = await this.resignApk(apk, resign);
      const args = ['install', '-r'];
      if (opts.downgrade) args.push('-d');
      args.push(file);
      const res = await this.adb.raw(args, { timeoutMs: 300_000 });
      const out = `${res.stdout.toString('utf8')}\n${res.stderr}`.trim();
      if (res.code !== 0 || !/\bSuccess\b/.test(out)) {
        const reason = /\[?(INSTALL_[A-Z_]+)/.exec(out)?.[1] ?? out.split('\n').pop();
        const hint =
          reason === 'INSTALL_FAILED_UPDATE_INCOMPATIBLE'
            ? ' The installed app is signed with a different key. Re-sign with that key: --resign --ks <keystore> (the debug keystore by default). duet does not uninstall, because that wipes the app data.'
            : reason === 'INSTALL_FAILED_VERSION_DOWNGRADE'
              ? ' The installed version is newer. Pass --downgrade to allow it.'
              : '';
        throw new DuetError(`Install failed: ${reason}.${hint}`, 'failed');
      }
      return { result: { installed: file, resigned: file !== apk } };
    });
  }

  private async resignApk(apk: string, o: ResignOptions): Promise<string> {
    const signer = findApksigner();
    const keystore = o.keystore ?? join(homedir(), '.android', 'debug.keystore');
    if (!existsSync(keystore)) throw new DuetError(`Keystore ${keystore} does not exist.`, 'not-found');
    const out = join(dirname(apk), basename(apk, '.apk') + '-duet-signed.apk');
    const args = ['sign', '--ks', keystore, '--ks-pass', o.storePass ?? 'pass:android', '--key-pass', o.keyPass ?? o.storePass ?? 'pass:android'];
    args.push('--ks-key-alias', o.alias ?? 'androiddebugkey', '--out', out, apk);
    const res = await this.runner(signer, args, { timeoutMs: 120_000 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        throw new DuetError('apksigner not found. Set APKSIGNER, or ANDROID_HOME so duet can find build-tools.', 'not-found');
      }
      throw e;
    });
    if (res.code !== 0) {
      const text = `${res.stderr}\n${res.stdout.toString('utf8')}`.trim();
      const java = /Unable to locate a Java Runtime|JAVA_HOME|java: command not found/i.test(text) ? ' apksigner needs Java: set JAVA_HOME.' : '';
      throw new DuetError(`apksigner failed: ${text.split('\n')[0]}.${java}`, 'failed');
    }
    return out;
  }

  private step<T>(action: string, args: Record<string, unknown>, fn: () => Promise<{ result: T; shot?: string; log?: string }>): Promise<T> {
    return this.run.step(this.name, action, args, fn);
  }
}

/** apksigner from APKSIGNER, then the newest build-tools under ANDROID_HOME / ANDROID_SDK_ROOT, then PATH. */
export function findApksigner(env: NodeJS.ProcessEnv = process.env): string {
  if (env.APKSIGNER) return env.APKSIGNER;
  for (const root of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter(Boolean) as string[]) {
    const bt = join(root, 'build-tools');
    if (!existsSync(bt)) continue;
    const versions = readdirSync(bt).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const p = join(bt, v, 'apksigner');
      if (existsSync(p)) return p;
    }
  }
  return 'apksigner';
}
