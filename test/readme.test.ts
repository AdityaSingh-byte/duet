// Keeps the docs honest: every duet command shown in the markdown must be a real command with real
// options, the scenario examples must load, MCP tool names must exist, and repo links must resolve.

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROWSER_COMMANDS, parse, PHONE_COMMANDS } from '../src/commands.js';
import { loadScenario } from '../src/scenario.js';
import { splitWords } from '../src/util/words.js';

const root = resolve(import.meta.dirname, '..');
const docs = ['README.md', 'CONTRIBUTING.md', 'sample/README.md', 'docs/story.md'].filter((f) => existsSync(join(root, f)));
const read = (f: string) => readFileSync(join(root, f), 'utf8');

function codeBlocks(md: string, lang: string): string[] {
  return [...md.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]!);
}

/** `duet ...` lines from sh blocks, as argv without the trailing # comment. */
function duetCommands(md: string): string[][] {
  const out: string[][] = [];
  for (const block of codeBlocks(md, 'sh')) {
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('duet ')) continue;
      const words = splitWords(t);
      const hash = words.findIndex((w) => w.startsWith('#'));
      out.push((hash >= 0 ? words.slice(0, hash) : words).slice(1));
    }
  }
  return out;
}

function checkCommand(argv: string[]): void {
  const [group, ...rest] = argv;
  if (group === '--help' || group === 'mcp') return;
  const { positionals } = parse(rest);
  const [cmd] = positionals;
  if (group === 'phone') expect(PHONE_COMMANDS.has(cmd!), `phone ${cmd}`).toBe(true);
  else if (group === 'browser') expect(BROWSER_COMMANDS.has(cmd!), `browser ${cmd}`).toBe(true);
  else if (group === 'scenario') {
    expect(['run', 'check'], `scenario ${cmd}`).toContain(cmd);
    expect(existsSync(join(root, positionals[1]!)), positionals[1]).toBe(true);
  } else if (group === 'report') return;
  else throw new Error(`unknown command group "${group}" in: duet ${argv.join(' ')}`);
}

describe('the docs match the CLI', () => {
  for (const f of docs) {
    const cmds = duetCommands(read(f));
    if (!cmds.length) continue;
    it(`${f}: ${cmds.length} duet commands parse`, () => {
      for (const argv of cmds) expect(() => checkCommand(argv), `duet ${argv.join(' ')}`).not.toThrow();
    });
  }

  it('README shows the core commands at least once', () => {
    const shown = new Set(duetCommands(read('README.md')).map((a) => `${a[0]} ${a[0] === 'phone' || a[0] === 'browser' ? parse(a.slice(1)).positionals[0] : ''}`.trim()));
    for (const c of ['phone status', 'phone tap', 'phone logs', 'phone rotation', 'phone install', 'browser open', 'browser click', 'scenario']) {
      expect(shown.has(c), c).toBe(true);
    }
  });
});

describe('the scenario examples load', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'duet-readme-'));
  it('README yaml block', () => {
    const [yaml] = codeBlocks(read('README.md'), 'yaml');
    expect(yaml).toBeDefined();
    const p = join(tmp, 'readme.yaml');
    writeFileSync(p, yaml!);
    const sc = loadScenario(p);
    expect(Object.keys(sc.actors)).toEqual(['host', 'viewer']);
    expect(sc.steps.length).toBeGreaterThan(5);
  });
  for (const f of readdirSync(join(root, 'examples')).filter((n) => n.endsWith('.yaml'))) {
    it(`examples/${f}`, () => {
      expect(loadScenario(join(root, 'examples', f)).steps.length).toBeGreaterThan(0);
    });
  }
});

describe('MCP tool names in the docs exist', () => {
  const server = readFileSync(join(root, 'src/mcp.ts'), 'utf8');
  const registered = new Set([...server.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]!));
  it('every `phone_*`, `browser_*`, ... name in the README is a registered tool', () => {
    const named = [...read('README.md').matchAll(/`((?:phone|browser|scenario|report|run)_[a-z_]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(5);
    for (const n of named) expect(registered.has(n), n).toBe(true);
  });
});

describe('links resolve', () => {
  const slug = (h: string) =>
    h
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, '')
      .replace(/ /g, '-');
  for (const f of docs) {
    it(`${f}: links to repo files and headings`, () => {
      const md = read(f);
      const headings = new Set([...md.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!)));
      for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!;
        if (/^(https?:|mailto:)/.test(target)) continue;
        if (target.startsWith('#')) expect(headings.has(target.slice(1)), `${f} ${target}`).toBe(true);
        else expect(existsSync(join(root, dirname(f), target.split('#')[0]!)), `${f} -> ${target}`).toBe(true);
      }
    });
  }
});
