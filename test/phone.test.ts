import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Adb } from '../src/phone/adb.js';
import { Phone } from '../src/phone/phone.js';
import { RunDir } from '../src/run.js';
import { DuetError } from '../src/util/errors.js';
import type { ExecResult, Runner } from '../src/util/exec.js';
import { solidPng } from './helpers.js';

const APP = 'dev.duet.sample';
const SERIAL = 'TEST123';
const uiXml = readFileSync(new URL('./fixtures/sample-screen.xml', import.meta.url), 'utf8');

interface FakeDevice {
  foreground: string;
  locked: boolean;
  rotation: 0 | 1 | 2 | 3;
  screen: [number, number];
  installResult?: string;
}

/** A pretend phone: answers the adb commands duet sends, and records them. */
function fakeAdb(dev: FakeDevice) {
  const calls: string[] = [];
  const ok = (out: string | Buffer, code = 0, stderr = ''): ExecResult => ({ code, stdout: Buffer.isBuffer(out) ? out : Buffer.from(out), stderr });
  const runner: Runner = async (_cmd, args) => {
    const a = args[0] === '-s' ? args.slice(2) : args;
    const line = a.join(' ');
    calls.push(line);
    if (line.startsWith('shell dumpsys window')) {
      const deg = dev.rotation * 90;
      return ok(
        `    mDreamingLockscreen=${dev.locked} mDreamingSleepToken=null\n  mCurrentFocus=Window{1a u0 ${dev.foreground}/${dev.foreground}.Main}\n    mRotation=ROTATION_${deg}\n`,
      );
    }
    if (line.startsWith('shell dumpsys activity')) {
      return ok(`    topResumedActivity=ActivityRecord{9f u0 ${dev.foreground}/.Main t42}\n    mKeyguardShowing=${dev.locked}\n`);
    }
    if (line.startsWith('shell dumpsys power')) return ok('  mWakefulness=Awake\n');
    if (line.includes('category.HOME')) return ok('priority=0 isDefault=true\ncom.example.launcher/.Home\n');
    if (line === 'exec-out screencap -p') {
      const [w, h] = dev.rotation % 2 ? [dev.screen[1], dev.screen[0]] : dev.screen;
      return ok(solidPng(w, h, [240, 240, 240]));
    }
    if (line.startsWith('shell uiautomator dump')) return ok('UI hierchary dumped to: /data/local/tmp/duet-ui.xml\n');
    if (line.startsWith('exec-out cat')) return ok(uiXml);
    if (line.startsWith('shell date')) return ok('1760550000.123456789\n');
    if (line.startsWith('install')) return dev.installResult ? ok(dev.installResult, 1) : ok('Performing Streamed Install\nSuccess\n');
    if (line.startsWith('logcat')) return ok('10-15 22:00:00.000  100  100 I App: rotation changed to 1\n10-15 22:00:00.100  100  100 I App: dialog dismissed\n');
    return ok('');
  };
  return { runner, calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duet-test-'));
});

function phoneFor(dev: FakeDevice) {
  const fake = fakeAdb(dev);
  const phone = new Phone(new Adb({ serial: SERIAL, runner: fake.runner }), { packages: [APP], run: new RunDir(dir), settleMs: 0 });
  return { phone, calls: fake.calls };
}

const base: FakeDevice = { foreground: APP, locked: false, rotation: 0, screen: [1080, 2340] };

describe('Phone', () => {
  it('screenshot: saves a scaled image and remembers the scale for later taps', async () => {
    const { phone } = phoneFor(base);
    const shot = await phone.screenshot({ label: 'start' });
    expect(shot.image).toEqual([724, 1568]);
    expect(shot.device).toEqual([1080, 2340]);
    expect(existsSync(shot.path)).toBe(true);
    expect(shot.path).toMatch(/shots\/001-phone-start\.png$/);
  });

  it('tap X Y: maps screenshot coordinates to device pixels', async () => {
    const { phone, calls } = phoneFor(base);
    await phone.screenshot();
    const r = await phone.tap({ x: 362, y: 1452 });
    expect(r).toMatchObject({ x: 540, y: 2166 });
    expect(calls).toContain('shell input tap 540 2166');
  });

  it('tap X Y: refuses after the screen rotated since the screenshot', async () => {
    const dev = { ...base };
    const { phone, calls } = phoneFor(dev);
    await phone.screenshot();
    dev.rotation = 1;
    await expect(phone.tap({ x: 10, y: 10 })).rejects.toThrow(/rotated since the last screenshot/);
    expect(calls.some((c) => c.startsWith('shell input'))).toBe(false);
  });

  it('tap --text: taps the centre of the best match', async () => {
    const { phone, calls } = phoneFor(base);
    const r = await phone.tap({ text: 'Join room' });
    expect(r).toMatchObject({ x: 540, y: 2166, matched: 'Join room', candidates: 2 });
    expect(calls).toContain('shell input tap 540 2166');
  });

  it('tap --text: a miss lists what is on screen', async () => {
    const { phone } = phoneFor(base);
    const err = await phone.tap({ text: 'Leave' }).catch((e: DuetError) => e);
    expect(err).toBeInstanceOf(DuetError);
    expect((err as DuetError).code).toBe('not-found');
    expect((err as DuetError).details?.onScreen).toContain('"Full screen" Button @1004,792 [clickable]');
  });

  it('the guard stops a tap while another app is in front, and sends no input', async () => {
    const { phone, calls } = phoneFor({ ...base, foreground: 'com.example.game' });
    const err = await phone.tap({ x: 1, y: 1, space: 'device' }).catch((e: DuetError) => e);
    expect((err as DuetError).code).toBe('guard');
    expect(calls.some((c) => c.startsWith('shell input'))).toBe(false);
  });

  it('the guard stops a screenshot while the phone is locked', async () => {
    const { phone, calls } = phoneFor({ ...base, locked: true });
    await expect(phone.screenshot()).rejects.toThrow(/locked/);
    expect(calls).not.toContain('exec-out screencap -p');
  });

  it('open-link quotes the URI for the device shell', async () => {
    const { phone, calls } = phoneFor(base);
    await phone.openLink('duet://room/42?go=1&mode=full');
    expect(calls).toContain(`shell am start -W -a android.intent.action.VIEW -d 'duet://room/42?go=1&mode=full' ${APP}`);
  });

  it('type: escapes spaces for input text and rejects non-ASCII', async () => {
    const { phone, calls } = phoneFor(base);
    await phone.type("it's me");
    expect(calls).toContain(`shell input text 'it'\\''s%sme'`);
    await expect(phone.type('नमस्ते')).rejects.toThrow(/ASCII/);
  });

  it('logs: reads since the mark without clearing, saves the capture, filters', async () => {
    const { phone, calls } = phoneFor(base);
    await phone.markLogs();
    const r = await phone.logs({ sinceMark: true, grep: 'rotation' });
    expect(calls).toContain('logcat -d -v threadtime -T 1760550000.123');
    expect(calls.some((c) => c.includes('logcat -c'))).toBe(false);
    expect(r.lines).toEqual(['10-15 22:00:00.000  100  100 I App: rotation changed to 1']);
    expect(r.total).toBe(2);
    expect(existsSync(r.path)).toBe(true);
  });

  it('install: explains a signature mismatch and never uninstalls', async () => {
    const apk = join(dir, 'app.apk');
    new RunDir(dir).write(apk, 'not really an apk');
    const { phone, calls } = phoneFor({
      ...base,
      installResult: 'adb: failed to install app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package signatures do not match]',
    });
    await expect(phone.install(apk)).rejects.toThrow(/signed with a different key/);
    expect(calls.some((c) => c.includes('uninstall'))).toBe(false);
  });

  it('records every step, passed or failed, to events.jsonl', async () => {
    const { phone } = phoneFor(base);
    await phone.screenshot();
    await phone.tap({ text: 'Nope' }).catch(() => {});
    const events = new RunDir(dir).events();
    expect(events.map((e) => [e.action, e.ok])).toEqual([
      ['screenshot', true],
      ['tap', false],
    ]);
    expect(events[0]!.shot).toBe('shots/001-phone.png');
  });
});
