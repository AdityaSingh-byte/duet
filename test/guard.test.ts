import { describe, expect, it } from 'vitest';
import { evaluateGuard, type PhoneStatus } from '../src/phone/guard.js';

const APP = 'dev.duet.sample';
const HOME = 'com.example.launcher';
const policy = { packages: [APP] };

function status(over: Partial<PhoneStatus> = {}): PhoneStatus {
  return {
    wakefulness: 'Awake',
    locked: false,
    foreground: { package: APP, activity: `${APP}.MainActivity` },
    focus: `${APP}/${APP}.MainActivity`,
    home: HOME,
    rotation: 0,
    ...over,
  };
}

describe('evaluateGuard', () => {
  it('allows everything while the app under test is in front', () => {
    for (const kind of ['observe', 'launch', 'act'] as const) {
      expect(evaluateGuard(status(), policy, kind)).toEqual({ ok: true, reasons: [] });
    }
  });

  it('on the home screen: may look and launch, may not tap', () => {
    const home = status({ foreground: { package: HOME, activity: `${HOME}.Home` } });
    expect(evaluateGuard(home, policy, 'observe').ok).toBe(true);
    expect(evaluateGuard(home, policy, 'launch').ok).toBe(true);
    const act = evaluateGuard(home, policy, 'act');
    expect(act.ok).toBe(false);
    expect(act.reasons[0]).toContain('home screen');
  });

  it('refuses everything while another app is in front (the owner is using the phone)', () => {
    const busy = status({ foreground: { package: 'com.example.game', activity: 'com.example.game.Main' } });
    for (const kind of ['observe', 'launch', 'act'] as const) {
      const v = evaluateGuard(busy, policy, kind);
      expect(v.ok).toBe(false);
      expect(v.reasons.join()).toContain('com.example.game');
    }
  });

  it('refuses when locked, asleep or the shade is down', () => {
    expect(evaluateGuard(status({ locked: true }), policy, 'observe').reasons).toContain('the phone is locked');
    expect(evaluateGuard(status({ wakefulness: 'Asleep' }), policy, 'observe').reasons).toContain('the screen is asleep');
    expect(evaluateGuard(status({ focus: 'NotificationShade' }), policy, 'act').ok).toBe(false);
  });

  it('fails closed on anything it could not read', () => {
    expect(evaluateGuard(status({ locked: null }), policy, 'observe').ok).toBe(false);
    expect(evaluateGuard(status({ wakefulness: null }), policy, 'observe').ok).toBe(false);
    expect(evaluateGuard(status({ foreground: null }), policy, 'observe').ok).toBe(false);
  });

  it('will not tap anything when no app under test is configured', () => {
    expect(evaluateGuard(status(), { packages: [] }, 'act').ok).toBe(false);
  });
});
