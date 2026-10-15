import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BrowserActor, BrowserRegistry, type OpenOptions } from './browser/browser.js';
import { isAlive } from './browser/chrome.js';
import { browserCommand, parse, phoneCommand, type CommandContext } from './commands.js';
import type { DuetConfig } from './config.js';
import { Phone } from './phone/phone.js';
import { RunDir } from './run.js';
import { DuetError } from './util/errors.js';
import { splitWords } from './util/words.js';

interface PhoneDef {
  serial?: string;
  package?: string | string[];
  noGuard?: boolean;
  maxEdge?: number;
}

interface BrowserDef {
  url?: string;
  fakeMedia?: boolean;
  fakeVideo?: string;
  captureTitle?: string;
  size?: string;
  position?: string;
}

export interface Scenario {
  name: string;
  actors: Record<string, { phone?: PhoneDef; browser?: BrowserDef }>;
  steps: Step[];
}

export type Step =
  | { index: number; source: string; kind: 'phone' | 'browser'; actor: string; argv: string[] }
  | { index: number; source: string; kind: 'pause'; ms: number }
  | { index: number; source: string; kind: 'note'; text: string };

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/**
 * Replaces ${NAME} with an environment variable (or SCENARIO_DIR), and ${NAME:-fallback} with the
 * variable or the fallback. An unset variable without a fallback is an error, not an empty string.
 */
function interpolate(text: string, vars: Record<string, string | undefined>, where: string): string {
  return text.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => {
    const v = vars[name] ?? fallback;
    if (v === undefined) throw new DuetError(`${where}: \${${name}} is not set.`, 'usage');
    return v;
  });
}

function interpolateDeep<T>(value: T, vars: Record<string, string | undefined>, where: string): T {
  if (typeof value === 'string') return interpolate(value, vars, where) as T;
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, vars, where)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, vars, where)])) as T;
  }
  return value;
}

/** Reads and checks a scenario file. Every problem is reported with the step it is in. */
export function loadScenario(path: string): Scenario {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new DuetError(`${path}: ${(e as Error).message}`, 'usage');
  }
  const d = doc as { name?: unknown; actors?: unknown; steps?: unknown };
  if (!d || typeof d !== 'object') throw new DuetError(`${path} is empty.`, 'usage');
  const name = typeof d.name === 'string' ? d.name : basename(path).replace(/\.ya?ml$/, '');
  const vars = { ...process.env, SCENARIO_DIR: resolve(dirname(path)) };
  const actors = interpolateDeep((d.actors ?? {}) as Scenario['actors'], vars, 'actors');
  for (const [actor, def] of Object.entries(actors)) {
    if (!NAME_RE.test(actor)) throw new DuetError(`Actor name "${actor}" should be a short word such as host or viewer.`, 'usage');
    if (!def || (!def.phone && !def.browser) || (def.phone && def.browser)) {
      throw new DuetError(`Actor "${actor}" needs exactly one of "phone:" or "browser:".`, 'usage');
    }
  }
  // Steps are either a YAML list of one-key maps, or (easier to write) a text block with one
  // "actor: command" per line, where colons and quotes inside the command need no YAML escaping.
  const rawSteps: unknown[] =
    typeof d.steps === 'string'
      ? d.steps
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
          .map((l) => {
            const m = /^([\w-]+):\s*(.*)$/.exec(l);
            if (!m) throw new DuetError(`Step "${l}" should look like "actor: command".`, 'usage');
            return { [m[1]!]: m[2]! };
          })
      : Array.isArray(d.steps)
        ? d.steps
        : [];
  if (!rawSteps.length) throw new DuetError(`${path} has no steps.`, 'usage');

  const steps: Step[] = rawSteps.map((raw: unknown, i: number): Step => {
    const where = `step ${i + 1}`;
    if (!raw || typeof raw !== 'object' || Object.keys(raw).length !== 1) {
      throw new DuetError(`${where}: write each step as "- actor: command", e.g. "- viewer: tap --text Join".`, 'usage');
    }
    let [key, value] = Object.entries(raw)[0]! as [string, unknown];
    const source = `${key}: ${String(value)}`;
    if (typeof value === 'string') value = interpolate(value, vars, where);
    if (key === 'pause') {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms < 0) throw new DuetError(`${where}: pause takes milliseconds.`, 'usage');
      return { index: i + 1, source, kind: 'pause', ms };
    }
    if (key === 'note') return { index: i + 1, source, kind: 'note', text: String(value) };
    const def = actors[key];
    if (!def) throw new DuetError(`${where}: "${key}" is not one of the actors (${Object.keys(actors).join(', ') || 'none declared'}).`, 'usage');
    if (typeof value !== 'string' || !value.trim()) throw new DuetError(`${where}: "${key}:" needs a command.`, 'usage');
    let argv: string[];
    try {
      argv = splitWords(value);
    } catch (e) {
      throw new DuetError(`${where}: ${(e as Error).message}`, 'usage');
    }
    try {
      parse(argv);
    } catch (e) {
      throw new DuetError(`${where}: ${(e as Error).message}`, 'usage');
    }
    return { index: i + 1, source, kind: def.phone ? 'phone' : 'browser', actor: key, argv };
  });
  return { name, actors, steps };
}

export interface ScenarioResult {
  ok: boolean;
  name: string;
  runDir: string;
  steps: number;
  passed: number;
  failed?: { index: number; source: string; error: string };
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function pair(v: string | undefined, sep: RegExp): [number, number] | undefined {
  if (!v) return undefined;
  const parts = v.split(sep).map(Number);
  return parts.length === 2 && parts.every(Number.isFinite) ? (parts as [number, number]) : undefined;
}

/**
 * Runs a scenario: every step in order, recorded to a fresh run folder.
 * Stops at the first failing step and collects evidence from every actor:
 * a screenshot each, and each phone's logs since the scenario started.
 */
export async function runScenario(path: string, opts: { cfg: DuetConfig; runsDir?: string; keepOpen?: boolean; log?: (line: string) => void }): Promise<ScenarioResult> {
  const scenario = loadScenario(path);
  const slug = scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const run = new RunDir(join(opts.runsDir ?? 'runs', `${stamp()}-${slug || 'scenario'}`));
  const registry = new BrowserRegistry();
  const log = opts.log ?? (() => {});
  const phones = new Map<string, Phone>();
  const browsers = new Map<string, BrowserActor>();
  const launchedHere = new Set<string>();

  const phoneFor = async (actor: string): Promise<Phone> => {
    let phone = phones.get(actor);
    if (!phone) {
      const def = scenario.actors[actor]!.phone!;
      const packages = def.package ? [def.package].flat() : (opts.cfg.phone?.packages ?? []);
      phone = await Phone.connect({
        name: actor,
        serial: def.serial ?? opts.cfg.phone?.serial,
        packages,
        noGuard: def.noGuard,
        maxEdge: def.maxEdge ?? opts.cfg.phone?.maxEdge,
        settleMs: opts.cfg.phone?.settleMs,
        run,
      });
      phones.set(actor, phone);
    }
    return phone;
  };

  const openDefaults = (actor: string): Partial<OpenOptions> => {
    const def = scenario.actors[actor]?.browser ?? {};
    return {
      url: def.url,
      fakeMedia: def.fakeMedia,
      fakeVideo: def.fakeVideo,
      captureTitle: def.captureTitle,
      windowSize: pair(def.size, /x/i),
      windowPosition: pair(def.position, /,/),
    };
  };

  const browserFor = async (actor: string, tab?: string): Promise<BrowserActor> => {
    if (tab) return BrowserActor.attach(actor, { run, registry, tab });
    let b = browsers.get(actor);
    if (!b) {
      const rec = registry.get(actor);
      const running = rec ? await isAlive(rec.port) : false;
      const { actor: opened, launched } = await BrowserActor.open(actor, { ...openDefaults(actor), run, registry });
      if (launched && !running) launchedHere.add(actor);
      b = opened;
      browsers.set(actor, b);
    }
    return b;
  };

  const ctx: CommandContext = {
    cfg: opts.cfg,
    run,
    registry,
    phone: async () => {
      throw new Error('unreachable: phone steps resolve their actor first');
    },
    browser: (name, tab) => browserFor(name, tab),
    release: async (actor) => {
      if (!browsers.has(actor.name) || browsers.get(actor.name) !== actor) await actor.detach();
    },
    openDefaults,
  };

  run.record({ actor: 'scenario', action: 'start', ok: true, args: { name: scenario.name, file: basename(path), actors: scenario.actors, steps: scenario.steps.map((s) => s.source) } });
  log(`${scenario.name}: ${scenario.steps.length} steps -> ${run.dir}`);

  let passed = 0;
  let failed: ScenarioResult['failed'];
  try {
    // Connect every phone and mark its log first, so a failure can show exactly what each device logged during the run.
    try {
      for (const [actor, def] of Object.entries(scenario.actors)) {
        if (def.phone) await (await phoneFor(actor)).markLogs();
      }
    } catch (e) {
      failed = { index: 0, source: 'setup', error: (e as Error).message };
      log(`  setup failed: ${failed.error}`);
    }
    for (const step of failed ? [] : scenario.steps) {
      run.record({ actor: 'scenario', action: 'step', ok: true, args: { index: step.index, source: step.source } });
      log(`  ${step.index}. ${step.source}`);
      try {
        if (step.kind === 'pause') await new Promise((r) => setTimeout(r, step.ms));
        else if (step.kind === 'note') {
          /* a heading in the report */
        } else if (step.kind === 'phone') {
          const { values, positionals } = parse(step.argv);
          const phone = await phoneFor(step.actor);
          await phoneCommand(values, positionals, { ...ctx, phone: async () => phone });
        } else {
          const { values, positionals } = parse(step.argv);
          const [cmd, ...rest] = positionals;
          await browserCommand(values, [cmd!, step.actor, ...rest], ctx);
        }
        passed++;
      } catch (e) {
        failed = { index: step.index, source: step.source, error: (e as Error).message };
        log(`     failed: ${failed.error}`);
        break;
      }
    }
    if (failed && failed.index > 0) await collectEvidence(run, phones, browsers, log);
  } finally {
    for (const [name, b] of browsers) {
      if (launchedHere.has(name) && !opts.keepOpen) await b.close(registry).catch(() => {});
      else await b.detach().catch(() => {});
    }
    run.record({ actor: 'scenario', action: 'end', ok: !failed, args: { passed, total: scenario.steps.length }, error: failed?.error });
  }
  return { ok: !failed, name: scenario.name, runDir: run.dir, steps: scenario.steps.length, passed, failed };
}

async function collectEvidence(run: RunDir, phones: Map<string, Phone>, browsers: Map<string, BrowserActor>, log: (l: string) => void) {
  run.record({ actor: 'scenario', action: 'evidence', ok: true });
  for (const [name, phone] of phones) {
    await phone.logs({ sinceMark: true, label: 'at-failure', max: 80 }).catch((e: Error) => log(`     no logs from ${name}: ${e.message}`));
    await phone.screenshot({ label: 'at-failure' }).catch((e: Error) => log(`     no screenshot from ${name}: ${e.message}`));
  }
  for (const [name, b] of browsers) {
    await b.screenshot({ label: 'at-failure' }).catch((e: Error) => log(`     no screenshot from ${name}: ${e.message}`));
  }
}
