import { describe, expect, it } from 'vitest';
import {
  parseDevices,
  parseFocus,
  parseKeyguard,
  parsePids,
  parseResolvedPackage,
  parseRotation,
  parseTopActivity,
  parseWakefulness,
  parseWmSize,
} from '../src/phone/parse.js';

describe('parseDevices', () => {
  it('reads ready, unauthorized and emulator rows and skips daemon noise', () => {
    const out = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'R5CX1234ABC            device usb:1-1 product:pa3q model:SM_X000 device:pa3q transport_id:3',
      'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
      '0123456789ABCDEF       unauthorized usb:1-2 transport_id:4',
      '',
    ].join('\n');
    expect(parseDevices(out)).toEqual([
      { serial: 'R5CX1234ABC', state: 'device', model: 'SM_X000', product: 'pa3q', transportId: '3' },
      { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_arm64', product: 'sdk_gphone64_arm64', transportId: '1' },
      { serial: '0123456789ABCDEF', state: 'unauthorized', transportId: '4' },
    ]);
  });
});

describe('parseTopActivity', () => {
  it('reads topResumedActivity and expands a relative activity name', () => {
    const out = '    topResumedActivity=ActivityRecord{9f8e7d6 u0 dev.duet.sample/.MainActivity t42}\n';
    expect(parseTopActivity(out)).toEqual({ package: 'dev.duet.sample', activity: 'dev.duet.sample.MainActivity' });
  });
  it('falls back to mResumedActivity on older builds', () => {
    const out = '  mResumedActivity: ActivityRecord{4a1b u0 com.example.launcher/com.example.launcher.Home t1}';
    expect(parseTopActivity(out)).toEqual({ package: 'com.example.launcher', activity: 'com.example.launcher.Home' });
  });
  it('returns null when nothing matches', () => {
    expect(parseTopActivity('ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)')).toBeNull();
  });
});

describe('parseKeyguard', () => {
  it('any true field means locked', () => {
    expect(parseKeyguard('mDreamingLockscreen=false\n  isKeyguardShowing=true')).toBe(true);
    expect(parseKeyguard('  KeyguardController:\n    mKeyguardShowing=true')).toBe(true);
  });
  it('all false means unlocked', () => {
    expect(parseKeyguard('mDreamingLockscreen=false mDreamingSleepToken=null\nisKeyguardShowing=false')).toBe(false);
  });
  it('no field at all is unknown, not unlocked', () => {
    expect(parseKeyguard('mCurrentFocus=Window{1 u0 x/y}')).toBeNull();
  });
});

describe('small parsers', () => {
  it('wakefulness', () => {
    expect(parseWakefulness('  mWakefulness=Awake\n  mWakefulnessChanging=false')).toBe('Awake');
    expect(parseWakefulness('mWakefulness=Asleep')).toBe('Asleep');
    expect(parseWakefulness('')).toBeNull();
  });

  it('rotation in degrees (newer builds) and quarter turns (older)', () => {
    expect(parseRotation('    mRotation=ROTATION_90 mLastOrientation=-1')).toBe(1);
    expect(parseRotation('mRotation=ROTATION_270')).toBe(3);
    expect(parseRotation('  mRotation=0 mAltRotation=false')).toBe(0);
    expect(parseRotation('mCurrentRotation=ROTATION_180')).toBe(2);
    expect(parseRotation('mRotation=ROTATION_45')).toBeNull();
    expect(parseRotation('nothing')).toBeNull();
  });

  it('wm size with and without an override', () => {
    expect(parseWmSize('Physical size: 1080x2340\n')).toEqual({ physical: [1080, 2340] });
    expect(parseWmSize('Physical size: 1440x3120\nOverride size: 1080x2340\n')).toEqual({ physical: [1440, 3120], override: [1080, 2340] });
  });

  it('resolved package from resolve-activity --brief', () => {
    const out = 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.example.launcher/.activities.Launcher\n';
    expect(parseResolvedPackage(out)).toBe('com.example.launcher');
    expect(parseResolvedPackage('No activity found')).toBeNull();
  });

  it('focus window, app or system', () => {
    expect(parseFocus('  mCurrentFocus=Window{1a2b u0 dev.duet.sample/dev.duet.sample.MainActivity}')).toBe(
      'dev.duet.sample/dev.duet.sample.MainActivity',
    );
    expect(parseFocus('  mCurrentFocus=Window{77 u0 NotificationShade}')).toBe('NotificationShade');
    expect(parseFocus('  mCurrentFocus=null')).toBeNull();
  });

  it('pids', () => {
    expect(parsePids('12345 12399\n')).toEqual([12345, 12399]);
    expect(parsePids('')).toEqual([]);
  });
});
