import { describe, expect, it } from 'vitest';
import { chromeArgs } from '../src/browser/chrome.js';

describe('chromeArgs', () => {
  it('fake media alone: fake devices and no permission prompts', () => {
    const args = chromeArgs({ profileDir: 'p', fakeMedia: true });
    expect(args).toContain('--use-fake-device-for-media-stream');
    expect(args).toContain('--use-fake-ui-for-media-stream');
  });

  it('with a capture tab: keeps the share picker so it can auto-select the tab by title', () => {
    // --use-fake-ui-for-media-stream skips the picker and shares a fake test pattern instead of the tab.
    const args = chromeArgs({ profileDir: 'p', fakeMedia: true, captureTitle: 'Slides' });
    expect(args).not.toContain('--use-fake-ui-for-media-stream');
    expect(args).toContain('--auto-accept-camera-and-microphone-capture');
    expect(args).toContain('--auto-select-tab-capture-source-by-title=Slides');
  });

  it('always uses its own profile and a random DevTools port', () => {
    const args = chromeArgs({ profileDir: '.duet/profiles/host' });
    expect(args.some((a) => a.startsWith('--user-data-dir=/') && a.endsWith('.duet/profiles/host'))).toBe(true);
    expect(args).toContain('--remote-debugging-port=0');
    expect(args.some((a) => a.includes('fake'))).toBe(false);
  });
});
