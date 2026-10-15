import { BrowserActor, BrowserRegistry } from './browser/browser.js';
import { browserCommand, HELP, parse, phoneCommand, type CommandContext } from './commands.js';
import { loadConfig } from './config.js';
import { Phone } from './phone/phone.js';
import { buildReport } from './report.js';
import { RunDir } from './run.js';
import { loadScenario, runScenario } from './scenario.js';
import { DuetError, exitCodes } from './util/errors.js';

function print(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new DuetError(`--max-edge must be a number, got "${v}".`, 'usage');
  return n;
}

export async function main(argv: string[]): Promise<void> {
  try {
    const [group, ...rest] = argv;
    if (!group || group === 'help' || group === '--help' || group === '-h') {
      process.stdout.write(HELP + '\n');
      return;
    }
    const { values, positionals } = parse(rest);
    if (values.help || (!positionals[0] && group !== 'report')) {
      process.stdout.write(HELP + '\n');
      return;
    }
    const cfg = loadConfig();
    const run = RunDir.fromEnv(values['run-dir'] ?? cfg.runDir);
    const ctx: CommandContext = {
      cfg,
      run,
      registry: new BrowserRegistry(),
      phone: (o) => {
        const envPackages = process.env.DUET_PACKAGE?.split(',').map((s) => s.trim()).filter(Boolean);
        return Phone.connect({
          serial: o.serial ?? cfg.phone?.serial,
          packages: o.package ?? envPackages ?? cfg.phone?.packages ?? [],
          noGuard: o['no-guard'],
          maxEdge: num(o['max-edge']) ?? cfg.phone?.maxEdge,
          settleMs: cfg.phone?.settleMs,
          run,
        });
      },
      browser: (name, tab) => BrowserActor.attach(name, { run, registry: ctx.registry, tab }),
      release: (actor) => actor.detach(),
    };
    if (group === 'scenario') {
      const [cmd, file] = positionals;
      if (!file) throw new DuetError('Missing the scenario FILE.', 'usage');
      if (cmd === 'check') {
        const sc = loadScenario(file);
        print({ ok: true, name: sc.name, actors: Object.keys(sc.actors), steps: sc.steps.map((st) => st.source) });
        return;
      }
      if (cmd !== 'run') throw new DuetError(`Unknown scenario command "${cmd}". Use run or check.`, 'usage');
      const result = await runScenario(file, {
        cfg,
        runsDir: values['runs-dir'],
        keepOpen: values['keep-open'],
        log: (line) => process.stderr.write(line + '\n'),
      });
      const report = buildReport(result.runDir);
      print({ ...result, report });
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (group === 'report') {
      const dir = positionals[0] ?? run.dir;
      print({ ok: true, report: buildReport(dir, { inline: values.inline, out: values.out }) });
      return;
    }
    if (group === 'phone') print({ ok: true, ...(await phoneCommand(values, positionals, ctx)) });
    else if (group === 'browser') print({ ok: true, ...(await browserCommand(values, positionals, ctx)) });
    else throw new DuetError(`Unknown command "${group}". Try "duet phone status" or "duet browser list".`, 'usage');
  } catch (e) {
    const err = e instanceof DuetError ? e : new DuetError((e as Error).message ?? String(e));
    print({ ok: false, code: err.code, error: err.message, ...(err.details ? { details: err.details } : {}) });
    process.exitCode = exitCodes[err.code];
  }
}
