import { BrowserActor, BrowserRegistry } from './browser/browser.js';
import { browserCommand, HELP, parse, phoneCommand, type CommandContext } from './commands.js';
import { loadConfig } from './config.js';
import { Phone } from './phone/phone.js';
import { buildReport } from './report.js';
import { RunDir } from './run.js';
import { loadScenario, runScenario } from './scenario.js';
import { composeRunVideo } from './video.js';
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
    if (group === 'mcp') {
      const { startMcpServer } = await import('./mcp.js');
      await startMcpServer();
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
      const pace = values.pace === undefined ? undefined : Number(values.pace);
      if (pace !== undefined && !Number.isFinite(pace)) throw new DuetError('--pace takes milliseconds.', 'usage');
      const result = await runScenario(file, {
        cfg,
        runsDir: values['runs-dir'],
        keepOpen: values['keep-open'],
        record: values.record,
        paceMs: pace,
        log: (line) => process.stderr.write(line + '\n'),
      });
      let video: Awaited<ReturnType<typeof composeRunVideo>> | undefined;
      if (values.record) {
        try {
          video = await composeRunVideo(result.runDir, { gif: values.gif, warn: (m) => process.stderr.write(`  ${m}\n`) });
        } catch (e) {
          process.stderr.write(`  no video: ${(e as Error).message}\n`);
        }
      }
      const report = buildReport(result.runDir);
      print({ ...result, report, ...(video ? { video } : {}) });
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (group === 'video') {
      const dir = positionals[0];
      if (!dir) throw new DuetError('Missing RUN_DIR.', 'usage');
      const video = await composeRunVideo(dir, { gif: values.gif, warn: (m) => process.stderr.write(`  ${m}\n`) });
      buildReport(dir);
      print({ ok: true, ...video });
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
