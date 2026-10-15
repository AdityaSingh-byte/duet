// The phone guard. A test phone is often someone's own phone, in use while the agent works.
// Before every action duet reads who is in front and whether the phone is awake and unlocked,
// and refuses unless it is safe. Anything it cannot read counts as unsafe.

import type { Activity, Rotation, Wakefulness } from './parse.js';

export interface PhoneStatus {
  wakefulness: Wakefulness | null;
  locked: boolean | null;
  foreground: Activity | null;
  focus: string | null;
  home: string | null;
  rotation: Rotation | null;
}

/**
 * observe: screenshot, element tree, wait-for. Allowed on the home screen or your app.
 * launch: deep links and app launch. Allowed on the home screen or your app.
 * act: taps, swipes, typing, keys. Only while your app is in front.
 */
export type ActionKind = 'observe' | 'launch' | 'act';

export interface GuardPolicy {
  /** Packages under test. Your app, plus anything it hands off to that you also drive. */
  packages: string[];
}

export interface GuardVerdict {
  ok: boolean;
  reasons: string[];
}

const SYSTEM_FOCUS = /NotificationShade|StatusBar|Keyguard|LockScreen|BouncerView/i;

export function evaluateGuard(s: PhoneStatus, policy: GuardPolicy, kind: ActionKind): GuardVerdict {
  const reasons: string[] = [];
  if (s.wakefulness !== 'Awake') {
    reasons.push(s.wakefulness ? `the screen is ${s.wakefulness.toLowerCase()}` : 'could not read whether the screen is on');
  }
  if (s.locked !== false) {
    reasons.push(s.locked ? 'the phone is locked' : 'could not read whether the phone is locked');
  }
  if (s.focus && SYSTEM_FOCUS.test(s.focus)) {
    reasons.push(`a system window has focus (${s.focus}), probably the notification shade`);
  }
  const pkg = s.foreground?.package;
  if (!pkg) {
    reasons.push('could not tell which app is in front');
  } else {
    const ours = policy.packages.includes(pkg);
    const home = pkg === s.home;
    if (kind === 'act' && !ours) {
      reasons.push(
        home
          ? 'the home screen is in front; duet only taps and types inside your app (launch it first)'
          : `"${pkg}" is in front, not your app. The phone may be in use`,
      );
    } else if (kind !== 'act' && !ours && !home) {
      reasons.push(`"${pkg}" is in front. The phone may be in use; duet waits for the home screen or your app`);
    }
    if (!policy.packages.length && kind === 'act') {
      reasons.push('no app under test is set (pass --package or set phone.packages in duet.config.json)');
    }
  }
  return { ok: reasons.length === 0, reasons };
}
