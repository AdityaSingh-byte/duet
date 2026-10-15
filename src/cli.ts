import { parseArgs, type ParseArgsConfig } from 'node:util';
import { loadConfig } from './config.js';
import { listDevices } from './phone/adb.js';
import { evaluateGuard } from './phone/guard.js';
import { Phone } from './phone/phone.js';
import { RunDir } from './run.js';
import { DuetError, exitCodes } from './util/errors.js';

const HELP = `duet: let an AI agent drive a real Android phone (and soon a browser) safely, step by step.

Usage: duet phone <command> [options]

Look
  devices                       connected devices
  status                        what is in front, locked or not, and whether duet would act
  screenshot [--label L] [--max-edge PX]
                                save a screenshot sized for the model; prints its scale
  ui [--all]                    elements on screen: label, type, centre, flags
  wait-for --text T [--gone]    wait until an element appears (or disappears)
  rotation                      display rotation and whether it is landscape
  logs mark                     remember "now" on the device clock
  logs [--since-mark] [--grep RE] [--app] [--max N]
                                read logcat without clearing it

Act (only while your app is in front)
  tap X Y                       coordinates on the LAST SCREENSHOT (use --device for raw pixels)
  tap --text T [--exact|--regex] [--index N]
  swipe X1 Y1 X2 Y2 [--ms 300]
  type TEXT                     ASCII only, into the focused field
  key NAME                      e.g. BACK, ENTER, KEYCODE_TAB
  back

Launch (from the home screen or your app)
  open-link URI [--package P]   deep link or web link
  launch [--package P]
  install APK [--resign] [--ks PATH] [--ks-pass SPEC] [--key-pass SPEC] [--alias A] [--downgrade]

Options
  --serial S        device to use (else ANDROID_SERIAL, else the only one connected)
  --package P       app under test; repeat for more (else DUET_PACKAGE or duet.config.json)
  --run-dir D       where steps, shots and logs are recorded (default .duet/run)
  --shot            take a screenshot after an action
  --no-guard        skip the safety checks (a dedicated lab device only)

Every command prints one JSON object. Exit codes: 0 ok, 1 failed, 2 usage, 3 refused by the guard,
4 device problem, 5 not found, 6 timed out.`;

const options = {
  serial: { type: 'string' },
  package: { type: 'string', multiple: true },
  'run-dir': { type: 'string' },
  'no-guard': { type: 'boolean' },
  shot: { type: 'boolean' },
  label: { type: 'string' },
  max: { type: 'string' },
  'max-edge': { type: 'string' },
  all: { type: 'boolean' },
  text: { type: 'string' },
  exact: { type: 'boolean' },
  regex: { type: 'boolean' },
  index: { type: 'string' },
  device: { type: 'boolean' },
  gone: { type: 'boolean' },
  timeout: { type: 'string' },
  ms: { type: 'string' },
  'since-mark': { type: 'boolean' },
  since: { type: 'string' },
  grep: { type: 'string' },
  app: { type: 'boolean' },
  resign: { type: 'boolean' },
  ks: { type: 'string' },
  'ks-pass': { type: 'string' },
  'key-pass': { type: 'string' },
  alias: { type: 'string' },
  downgrade: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsConfig['options'];

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new DuetError(`${name} must be a number, got "${v}".`, 'usage');
  return n;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new DuetError(`Missing ${what}. See "duet --help".`, 'usage');
  return v;
}

function print(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

export async function main(argv: string[]): Promise<void> {
  try {
    const [group, ...rest] = argv;
    if (!group || group === 'help' || group === '--help' || group === '-h') {
      process.stdout.write(HELP + '\n');
      return;
    }
    if (group !== 'phone') throw new DuetError(`Unknown command "${group}". Try "duet phone status".`, 'usage');
    print({ ok: true, ...(await phoneCommand(rest)) });
  } catch (e) {
    const err = e instanceof DuetError ? e : new DuetError((e as Error).message ?? String(e));
    print({ ok: false, code: err.code, error: err.message, ...(err.details ? { details: err.details } : {}) });
    process.exitCode = exitCodes[err.code];
  }
}

const PHONE_COMMANDS = new Set([
  'devices', 'status', 'screenshot', 'ui', 'wait-for', 'rotation', 'tap', 'swipe', 'type', 'key', 'back', 'open-link', 'launch', 'logs', 'install',
]);

function parse(argv: string[]) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new DuetError((e as Error).message, 'usage');
  }
}

async function phoneCommand(argv: string[]): Promise<Record<string, unknown>> {
  const { values: o, positionals } = parse(argv);
  const [cmd, ...pos] = positionals;
  if (o.help || !cmd) {
    process.stdout.write(HELP + '\n');
    process.exit(0);
  }
  if (!PHONE_COMMANDS.has(cmd)) throw new DuetError(`Unknown phone command "${cmd}". See "duet --help".`, 'usage');
  const cfg = loadConfig();
  const envPackages = process.env.DUET_PACKAGE?.split(',').map((s) => s.trim()).filter(Boolean);
  const packages = o.package ?? envPackages ?? cfg.phone?.packages ?? [];

  if (cmd === 'devices') return { devices: await listDevices() };

  const run = RunDir.fromEnv(o['run-dir'] ?? cfg.runDir);
  const phone = await Phone.connect({
    serial: o.serial ?? cfg.phone?.serial,
    packages,
    noGuard: o['no-guard'],
    maxEdge: num(o['max-edge'], '--max-edge') ?? cfg.phone?.maxEdge,
    settleMs: cfg.phone?.settleMs,
    run,
  });
  const shot = o.shot;

  switch (cmd) {
    case 'status': {
      const status = await phone.status();
      const act = evaluateGuard(status, phone.policy, 'act');
      return {
        serial: phone.adb.serial,
        packages,
        ...status,
        canObserve: evaluateGuard(status, phone.policy, 'observe').ok,
        canAct: act.ok,
        reasons: act.reasons,
      };
    }
    case 'screenshot':
      return { ...(await phone.screenshot({ label: o.label })) };
    case 'ui':
      return { elements: await phone.uiSummary({ all: o.all }) };
    case 'wait-for':
      return {
        ...(await phone.waitFor({ text: need(o.text, '--text'), gone: o.gone, exact: o.exact, regex: o.regex, timeoutMs: num(o.timeout, '--timeout') })),
      };
    case 'rotation':
      return { ...(await phone.rotation()) };
    case 'tap': {
      if (o.text) return { ...(await phone.tap({ text: o.text, exact: o.exact, regex: o.regex, index: num(o.index, '--index') }, { shot, label: o.label })) };
      const x = num(need(pos[0], 'X'), 'X')!;
      const y = num(need(pos[1], 'Y'), 'Y')!;
      return { ...(await phone.tap({ x, y, space: o.device ? 'device' : 'image' }, { shot, label: o.label })) };
    }
    case 'swipe': {
      const [x1, y1, x2, y2] = [0, 1, 2, 3].map((i) => num(need(pos[i], 'X1 Y1 X2 Y2'), 'coordinate')!);
      return { ...(await phone.swipe({ x: x1!, y: y1! }, { x: x2!, y: y2! }, { ms: num(o.ms, '--ms'), space: o.device ? 'device' : 'image', shot })) };
    }
    case 'type':
      return { ...(await phone.type(need(pos.join(' ') || undefined, 'TEXT'), { shot })) };
    case 'key':
      return { ...(await phone.key(need(pos[0], 'key name'), { shot })) };
    case 'back':
      return { ...(await phone.back({ shot })) };
    case 'open-link':
      return { ...(await phone.openLink(need(pos[0], 'URI'), { package: o.package?.[0], shot })) };
    case 'launch':
      return { ...(await phone.launch({ package: o.package?.[0], shot })) };
    case 'logs': {
      if (pos[0] === 'mark') return { ...(await phone.markLogs()) };
      return {
        ...(await phone.logs({ sinceMark: o['since-mark'], since: o.since, grep: o.grep, app: o.app, max: num(o.max, '--max'), label: o.label })),
      };
    }
    case 'install':
      return {
        ...(await phone.install(need(pos[0], 'APK path'), {
          resign: o.resign ? { keystore: o.ks, storePass: o['ks-pass'], keyPass: o['key-pass'], alias: o.alias } : undefined,
          downgrade: o.downgrade,
        })),
      };
    default:
      throw new DuetError(`Unknown phone command "${cmd}". See "duet --help".`, 'usage');
  }
}
