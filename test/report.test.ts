import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/report.js';
import { RunDir } from '../src/run.js';

describe('buildReport', () => {
  it('shows the failing step first and escapes everything that came from the device or page', () => {
    const run = new RunDir(mkdtempSync(join(tmpdir(), 'duet-rep-')));
    run.record({ actor: 'scenario', action: 'start', ok: true, args: { name: 'Full screen <test>', actors: { viewer: { phone: { package: 'dev.duet.sample' } } } } });
    run.record({ actor: 'scenario', action: 'step', ok: true, args: { index: 1, source: 'viewer: logs --grep Dialog' } });
    run.record({ actor: 'viewer', action: 'logs', ok: true, result: { lines: ['I Dialog: <script>alert(1)</script>'], matched: 1, total: 9 } });
    run.record({ actor: 'scenario', action: 'step', ok: true, args: { index: 2, source: 'viewer: rotation --expect landscape' } });
    run.record({ actor: 'viewer', action: 'rotation', ok: false, error: 'Expected landscape, but the phone is portrait (0 degrees).' });
    run.record({ actor: 'scenario', action: 'end', ok: false, args: { passed: 1, total: 2 }, error: 'x' });

    const html = readFileSync(buildReport(run.dir), 'utf8');
    expect(html).toContain('Failed at step 2 of 2.');
    expect(html).toContain('href="#step-2"');
    expect(html).toContain('Expected landscape, but the phone is portrait');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('<title>Full screen &lt;test&gt;</title>');
  });

  it('works for a plain CLI run with no scenario', () => {
    const run = new RunDir(mkdtempSync(join(tmpdir(), 'duet-rep-')));
    run.record({ actor: 'phone', action: 'tap', ok: true, args: { text: 'Join' }, result: { x: 540, y: 2166 }, ms: 300 });
    const html = readFileSync(buildReport(run.dir), 'utf8');
    expect(html).toContain('Passed. 1 of 1 steps');
    expect(html).toContain('tap &quot;Join&quot; at 540,2166');
  });
});

describe('notes', () => {
  it('render as section headings, not as steps', () => {
    const run = new RunDir(mkdtempSync(join(tmpdir(), 'duet-rep-')));
    run.record({ actor: 'scenario', action: 'step', ok: true, args: { index: 1, source: 'note: The host <joins>' } });
    run.record({ actor: 'scenario', action: 'step', ok: true, args: { index: 2, source: 'host: click --text Join' } });
    run.record({ actor: 'host', action: 'click', ok: true, args: { text: 'Join' }, result: { clicked: 'Join' } });
    const html = readFileSync(buildReport(run.dir), 'utf8');
    expect(html).toContain('<li class="note">The host &lt;joins&gt;</li>');
    expect(html).toContain('<code>host: click --text Join</code>');
  });
});
