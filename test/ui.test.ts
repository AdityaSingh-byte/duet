import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { center, findByText, parseUiDump, summarize } from '../src/phone/ui.js';

const xml = readFileSync(new URL('./fixtures/sample-screen.xml', import.meta.url), 'utf8');
const nodes = parseUiDump(xml);

describe('parseUiDump', () => {
  it('reads every node with depth and parent', () => {
    expect(nodes).toHaveLength(10);
    const fullScreen = nodes.find((n) => n.desc === 'Full screen')!;
    expect(fullScreen.depth).toBe(3);
    expect(nodes[fullScreen.parent!]!.desc).toBe('Stage');
    expect(fullScreen.clickable).toBe(true);
    expect(fullScreen.bounds).toEqual({ left: 960, top: 748, right: 1048, bottom: 836 });
  });

  it('decodes XML entities, named and numeric', () => {
    expect(nodes.some((n) => n.text === 'Terms & privacy • "v2"')).toBe(true);
  });

  it('keeps siblings at the right depth after a closed subtree', () => {
    const later = nodes.find((n) => n.text === 'Join room later')!;
    expect(later.depth).toBe(2);
    expect(nodes[later.parent!]!.resourceId).toBe('dev.duet.sample:id/root');
  });
});

describe('findByText', () => {
  it('prefers a whole-label match over a prefix match, and skips zero-size nodes', () => {
    const hits = findByText(nodes, 'join room');
    expect(hits.map((h) => h.text)).toEqual(['Join room', 'Join room later']);
    expect(center(hits[0]!.bounds)).toEqual({ x: 540, y: 2166 });
  });

  it('matches accessibility labels as well as text', () => {
    expect(findByText(nodes, 'Full screen')[0]?.className).toBe('android.widget.Button');
  });

  it('exact mode drops partial matches', () => {
    expect(findByText(nodes, 'Join', { exact: true })).toHaveLength(0);
    expect(findByText(nodes, 'join ROOM', { exact: true })).toHaveLength(1);
  });

  it('regex mode', () => {
    expect(findByText(nodes, '^room:', { regex: true })[0]?.text).toBe('Room: design review');
  });
});

describe('summarize', () => {
  it('lists labelled and clickable elements with centre and flags', () => {
    const lines = summarize(nodes);
    expect(lines).toContain('"Full screen" Button @1004,792 [clickable]');
    expect(lines).toContain('"" ViewGroup #join @540,2166 [clickable]');
    expect(lines.some((l) => l.includes('[clickable,disabled]'))).toBe(true);
    expect(lines.some((l) => l.includes('@0,0'))).toBe(false);
  });
});
