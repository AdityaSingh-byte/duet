import { describe, expect, it } from 'vitest';
import {
  parseDevices,
  parseFocus,
  parseKeyguard,
  parsePids,
  parseResolvedPackage,
  parseInjectionFailure,
  parseRotation,
  parseStuckPointers,
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

describe('parseRotation on a real Android 16 dump (Samsung)', () => {
  // Trimmed from `dumpsys window` on an Android 16 phone, portrait, then the same fields in landscape.
  // A stale window config and an app snapshot both say 0 while the display is at 90.
  const landscape = [
    '  overrideConfig={0.9 ldltr sw411dp w411dp h891dp 420dpi port winConfig={ mBounds=Rect(0, 0 - 1080, 2340) mDisplayRotation=ROTATION_0 mRotation=ROTATION_0 }}',
    '  mCurrentFocus=Window{fc5297b u0 dev.duet.sample/dev.duet.sample.MainActivity}',
    '     snapshot=TaskSnapshot{ mId=1 mTopActivityComponent=com.example.other/.Main mOrientation=1 mRotation=0 mTaskSize=Point(1080, 2340)',
    '    mRotation=1 mDeferredRotationPauseCount=0',
    '      mCurrentRotation=ROTATION_90',
    '  mGlobalConfiguration={0.9 ldltr sw411dp w891dp h411dp 420dpi land winConfig={ mDisplayRotation=ROTATION_90 mRotation=ROTATION_90 }}',
  ].join('\n');

  it('prefers the display rotation over stale configs and other apps\' snapshots', () => {
    expect(parseRotation(landscape)).toBe(1);
  });
  it('falls back through the older fields', () => {
    expect(parseRotation(landscape.replace('mCurrentRotation=ROTATION_90', ''))).toBe(1);
    expect(parseRotation('  mGlobalConfiguration={0.9 land winConfig={ mDisplayRotation=ROTATION_270 }}')).toBe(3);
  });
  it('ignores snapshot lines entirely', () => {
    expect(parseRotation('     snapshot=TaskSnapshot{ mOrientation=1 mRotation=1 }')).toBeNull();
  });
});

describe('injected-input rejections (real Android 16 lines)', () => {
  const down =
    'E/InputDispatcher(10136): Inconsistent event: MotionEvent { action=DOWN, id[0]=0, x[0]=540, y[0]=810, deviceId=5, source=TOUCHSCREEN, displayId=0}, reason: Injection on 0: Invalid DOWN event - pointers already down for device DeviceId(-1): {DeviceId(-1): {2}}\nW/InputManager(10136): Input event injection from pid 11067 failed.';
  const cancelStuck = 'reason: Injection on 0: Got ACTION_CANCEL, but the pointers don\'t match. Existing pointers: {DeviceId(-1): {2}}';
  const cancelClean = 'reason: Injection on 0: Got ACTION_CANCEL, but the pointers don\'t match. Existing pointers: {}';

  it('finds the pointer another tool left pressed', () => {
    expect(parseStuckPointers(down)).toEqual({ '-1': [2] });
    expect(parseStuckPointers(cancelStuck)).toEqual({ '-1': [2] });
    expect(parseStuckPointers('Existing pointers: {DeviceId(-1): {2, 3}, DeviceId(5): {0}}')).toEqual({ '-1': [2, 3], '5': [0] });
  });
  it('an empty set means nothing is stuck; no mention means unknown', () => {
    expect(parseStuckPointers(cancelClean)).toEqual({});
    expect(parseStuckPointers('nothing here')).toBeNull();
  });
  it('reads the rejection reason, or nothing when the event went through', () => {
    expect(parseInjectionFailure(down)).toBe('Injection on 0: Invalid DOWN event - pointers already down for device DeviceId(-1): {DeviceId(-1): {2}}');
    expect(parseInjectionFailure('')).toBeNull();
  });
});
