// Parsers for adb and dumpsys output. Pure functions, so they can be tested without a phone.
// dumpsys formats drift between Android versions and vendors; each parser accepts the variants
// we know about and returns null when it finds none, so callers can fail closed.

export interface DeviceInfo {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  transportId?: string;
}

/** `adb devices -l` */
export function parseDevices(out: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(device|offline|unauthorized|bootloader|recovery|sideload|authorizing|no permissions.*?)(?:\s+(.*))?$/.exec(
      line.trim(),
    );
    if (!m || line.startsWith('List of devices') || line.startsWith('*')) continue;
    const info: DeviceInfo = { serial: m[1]!, state: m[2]!.startsWith('no permissions') ? 'no permissions' : m[2]! };
    for (const pair of (m[3] ?? '').split(/\s+/)) {
      const [k, v] = pair.split(':');
      if (!v) continue;
      if (k === 'model') info.model = v;
      else if (k === 'product') info.product = v;
      else if (k === 'transport_id') info.transportId = v;
    }
    devices.push(info);
  }
  return devices;
}

export interface Activity {
  package: string;
  activity: string;
}

/**
 * The activity in front, from `dumpsys activity activities`.
 * Android 10+ prints `topResumedActivity=ActivityRecord{hash u0 pkg/.Act t12}`,
 * older builds `mResumedActivity: ActivityRecord{...}`.
 */
export function parseTopActivity(out: string): Activity | null {
  for (const key of ['topResumedActivity', 'mResumedActivity', 'ResumedActivity']) {
    const re = new RegExp(`\\b${key}\\s*[=:]\\s*ActivityRecord\\{\\S+\\s+u\\d+\\s+([\\w.]+)/([\\w.$]+)`);
    const m = re.exec(out);
    if (m) return { package: m[1]!, activity: expandActivity(m[1]!, m[2]!) };
  }
  return null;
}

function expandActivity(pkg: string, act: string): string {
  return act.startsWith('.') ? pkg + act : act;
}

/**
 * Whether the lock screen is up, from `dumpsys window` (policy section).
 * Several fields report it depending on the build; any `true` wins (fail closed),
 * all `false` means unlocked, none found means unknown.
 */
export function parseKeyguard(out: string): boolean | null {
  const fields = ['isKeyguardShowing', 'mKeyguardShowing', 'KeyguardShowing', 'mShowingLockscreen', 'mDreamingLockscreen', 'isStatusBarKeyguard'];
  let seen = false;
  for (const f of fields) {
    for (const m of out.matchAll(new RegExp(`\\b${f}=(true|false)\\b`, 'g'))) {
      seen = true;
      if (m[1] === 'true') return true;
    }
  }
  return seen ? false : null;
}

/**
 * The window with input focus, from `dumpsys window`: `mCurrentFocus=Window{abc u0 pkg/pkg.Act}`
 * or a system window such as `NotificationShade`. Returns the part after the user id.
 */
export function parseFocus(out: string): string | null {
  const m = /\bmCurrentFocus=Window\{\S+\s+u\d+\s+([^}\s]+)/.exec(out);
  return m ? m[1]! : null;
}

export type Wakefulness ='Awake' | 'Asleep' | 'Dozing' | 'Dreaming';

/** From `dumpsys power`: `mWakefulness=Awake`. */
export function parseWakefulness(out: string): Wakefulness | null {
  const m = /\bmWakefulness=(Awake|Asleep|Dozing|Dreaming)\b/.exec(out);
  return (m?.[1] as Wakefulness | undefined) ?? null;
}

/** Display rotation as a quarter-turn index 0..3. */
export type Rotation = 0 | 1 | 2 | 3;

/**
 * From `dumpsys window`. The output repeats `mRotation=` in many places, including saved
 * snapshots of other apps, so the display's own fields are tried first:
 * `mCurrentRotation=ROTATION_90` (DisplayRotation, Android 13+), then `mRotation=1` next to
 * `mDeferredRotationPauseCount` (older DisplayRotation), then `mDisplayRotation=ROTATION_90` in the
 * global configuration, then any `mRotation=`. Snapshot lines are ignored.
 * Degrees (ROTATION_90) and quarter turns (1) are both accepted.
 */
export function parseRotation(out: string): Rotation | null {
  const lines = out.split('\n').filter((l) => !/snapshot/i.test(l));
  const text = lines.join('\n');
  const patterns = [
    /\bmCurrentRotation=(ROTATION_)?(\d+)\b/,
    /\bmRotation=(ROTATION_)?(\d+)\s+mDeferredRotation/,
    /\bmGlobalConfiguration=.*?\bmDisplayRotation=(ROTATION_)(\d+)\b/,
    /\bmRotation=(ROTATION_)?(\d+)\b/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const n = Number(m[2]);
    const quarter = m[1] ? n / 90 : n;
    return Number.isInteger(quarter) && quarter >= 0 && quarter <= 3 ? (quarter as Rotation) : null;
  }
  return null;
}

export interface WmSize {
  physical: [number, number];
  override?: [number, number];
}

/** `wm size`: `Physical size: 1080x2340` and maybe `Override size: 720x1560`. */
export function parseWmSize(out: string): WmSize | null {
  const phys = /Physical size:\s*(\d+)x(\d+)/.exec(out);
  if (!phys) return null;
  const size: WmSize = { physical: [Number(phys[1]), Number(phys[2])] };
  const over = /Override size:\s*(\d+)x(\d+)/.exec(out);
  if (over) size.override = [Number(over[1]), Number(over[2])];
  return size;
}

/** `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME` */
export function parseResolvedPackage(out: string): string | null {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^([\w.]+)\/[\w.$]+$/.exec(lines[i]!);
    if (m) return m[1]!;
  }
  return null;
}

/** `pidof <package>` may print several pids. */
export function parsePids(out: string): number[] {
  return out
    .trim()
    .split(/\s+/)
    .filter((p) => /^\d+$/.test(p))
    .map(Number);
}
