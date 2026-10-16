import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadScenario } from '../src/scenario.js';
import { splitWords } from '../src/util/words.js';

const dir = mkdtempSync(join(tmpdir(), 'duet-scn-'));
function file(name: string, text: string): string {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}

const actors = `actors:
  host:
    browser:
      url: \${APP_URL}/host
  viewer:
    phone:
      package: dev.duet.sample
`;

afterEach(() => {
  delete process.env.APP_URL;
});

describe('splitWords', () => {
  it('splits like a shell for words and quotes', () => {
    expect(splitWords(`tap --text "Join room" --shot`)).toEqual(['tap', '--text', 'Join room', '--shot']);
    expect(splitWords(`eval "a('x')" --expect ''`)).toEqual(['eval', "a('x')", '--expect', '']);
    expect(splitWords(`say "she said \\"hi\\""`)).toEqual(['say', 'she said "hi"']);
    expect(() => splitWords(`tap --text "open`)).toThrow(/Unclosed/);
  });
});

describe('loadScenario', () => {
  it('reads text-block steps, where colons inside a command need no escaping', () => {
    process.env.APP_URL = 'http://localhost:5173';
    const sc = loadScenario(
      file(
        'a.yaml',
        `name: Demo\n${actors}steps: |\n  host: new-tab --title Slides --text "Slide 1: intro"\n  # a comment\n\n  viewer: tap --text "Full screen" --shot\n  pause: 500\n  note: the host is presenting\n`,
      ),
    );
    expect(sc.name).toBe('Demo');
    expect(sc.actors.host!.browser!.url).toBe('http://localhost:5173/host');
    expect(sc.steps.map((s) => s.kind)).toEqual(['browser', 'phone', 'pause', 'note']);
    expect(sc.steps[0]).toMatchObject({ actor: 'host', argv: ['new-tab', '--title', 'Slides', '--text', 'Slide 1: intro'] });
  });

  it('also reads a YAML list of one-key steps', () => {
    process.env.APP_URL = 'http://x';
    const sc = loadScenario(file('b.yaml', `${actors}steps:\n  - viewer: launch\n  - pause: 100\n`));
    expect(sc.steps).toHaveLength(2);
    expect(sc.name).toBe('b');
  });

  it('names the step and the problem when something is wrong', () => {
    process.env.APP_URL = 'http://x';
    expect(() => loadScenario(file('c.yaml', `${actors}steps: |\n  viewer: launch\n  guest: click --text Join\n`))).toThrow(
      /step 2: "guest" is not one of the actors \(host, viewer\)/,
    );
    expect(() => loadScenario(file('d.yaml', `${actors}steps: |\n  viewer: tap --nope\n`))).toThrow(/step 1: Unknown option '--nope'/);
    expect(() => loadScenario(file('e.yaml', `${actors}steps: |\n  viewer: tap --text "open\n`))).toThrow(/step 1: Unclosed/);
  });

  it('refuses an unset variable instead of substituting an empty string', () => {
    expect(() => loadScenario(file('f.yaml', `${actors}steps: |\n  viewer: launch\n`))).toThrow(/\$\{APP_URL\} is not set/);
  });

  it('keeps the variable name, not its value, in the step source (values may be secrets)', () => {
    process.env.APP_URL = 'http://secret-host';
    const sc = loadScenario(file('g.yaml', `${actors}steps: |\n  host: goto \${APP_URL}/admin\n`));
    expect(sc.steps[0]!.source).toBe('host: goto ${APP_URL}/admin');
    expect(sc.steps[0]).toMatchObject({ argv: ['goto', 'http://secret-host/admin'] });
  });

  it('an actor needs exactly one of phone or browser', () => {
    expect(() => loadScenario(file('h.yaml', `actors:\n  x: {}\nsteps: |\n  x: launch\n`))).toThrow(/exactly one of/);
  });
});

describe('variable fallbacks', () => {
  it('${NAME:-fallback} uses the fallback only when the variable is unset', () => {
    const p = file('i.yaml', `actors:\n  host:\n    browser:\n      url: \${APP_URL:-http://localhost:8080}\nsteps: |\n  host: goto \${APP_URL:-http://localhost:8080}/x\n`);
    expect(loadScenario(p).actors.host!.browser!.url).toBe('http://localhost:8080');
    process.env.APP_URL = 'http://other';
    expect(loadScenario(p).actors.host!.browser!.url).toBe('http://other');
  });
});

describe('runScenario', () => {
  it('a phone that cannot be reached fails the run before step 1, and the record says so', async () => {
    const { runScenario } = await import('../src/scenario.js');
    const { buildReport } = await import('../src/report.js');
    const { RunDir } = await import('../src/run.js');
    const { readFileSync } = await import('node:fs');
    const prev = process.env.DUET_ADB;
    process.env.DUET_ADB = join(dir, 'no-such-adb');
    try {
      const p = file('j.yaml', `actors:\n  viewer:\n    phone:\n      package: dev.duet.sample\nsteps: |\n  viewer: launch\n`);
      const r = await runScenario(p, { cfg: {}, runsDir: join(dir, 'runs') });
      expect(r.ok).toBe(false);
      expect(r.passed).toBe(0);
      expect(r.failed).toMatchObject({ index: 0, source: 'setup' });
      expect(r.failed!.error).toMatch(/adb not found/);
      const end = new RunDir(r.runDir).events().find((e) => e.action === 'end')!;
      expect(end.ok).toBe(false);
      expect(readFileSync(buildReport(r.runDir), 'utf8')).toContain('Failed before the first step.');
    } finally {
      if (prev === undefined) delete process.env.DUET_ADB;
      else process.env.DUET_ADB = prev;
    }
  });
});

describe('values passed between actors (--save)', () => {
  const two = `actors:\n  web:\n    browser:\n      url: http://localhost:8080\n  phone:\n    phone:\n      package: dev.duet.pair\n`;
  it('a later step can use a value an earlier eval saved; it is filled in at run time', () => {
    const sc = loadScenario(file('s1.yaml', `${two}steps: |\n  web: eval "document.querySelector('#code').textContent" --save CODE\n  phone: type \${CODE}\n`));
    expect(sc.steps[0]).toMatchObject({ saves: 'CODE' });
    expect(sc.steps[1]).toMatchObject({ argv: ['type', '${CODE}'] });
  });
  it('using a value before the step that saves it is an error', () => {
    expect(() => loadScenario(file('s2.yaml', `${two}steps: |\n  phone: type \${CODE}\n  web: eval "1" --save CODE\n`))).toThrow(
      /step 1: \$\{CODE\} is used before the step that saves it/,
    );
  });
  it('only browser eval steps can save, with an upper-case name', () => {
    expect(() => loadScenario(file('s3.yaml', `${two}steps: |\n  phone: ui --save CODE\n`))).toThrow(/--save works with a browser eval step/);
    expect(() => loadScenario(file('s4.yaml', `${two}steps: |\n  web: eval "1" --save code\n`))).toThrow(/upper-case name/);
  });
});
