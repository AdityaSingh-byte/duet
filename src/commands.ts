import { parseArgs, type ParseArgsConfig } from 'node:util';
import { BrowserActor, BrowserRegistry, type OpenOptions } from './browser/browser.js';
import { isAlive } from './browser/chrome.js';
import { type DuetConfig } from './config.js';
import { listDevices } from './phone/adb.js';
import { evaluateGuard } from './phone/guard.js';
import { Phone } from './phone/phone.js';
import { RunDir } from './run.js';
import { DuetError } from './util/errors.js';

export const HELP = `duet: let an AI agent test on a real Android phone and a visible browser, step by step.

Usage: duet phone <command> [options]
       duet browser <command> <name> [options]
       duet scenario run FILE [--keep-open] [--runs-dir D]
       duet scenario check FILE
       duet report [RUN_DIR] [--inline] [--out FILE]
       duet mcp                      serve every command as MCP tools over stdio

PHONE

Look
  devices                       connected devices
  status                        what is in front, locked or not, and whether duet would act
  screenshot [--label L] [--max-edge PX]
                                save a screenshot sized for the model; prints its scale
  ui [--all]                    elements on screen: label, type, centre, flags
  wait-for --text T [--gone]    wait until an element appears (or disappears)
  rotation [--expect landscape|portrait] [--timeout MS]
                                display rotation; with --expect, wait up to MS for it, else fail
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
  reverse PORT[:DEVICE_PORT]    let the phone reach this computer's PORT as localhost
  install APK [--resign] [--ks PATH] [--ks-pass SPEC] [--key-pass SPEC] [--alias A] [--downgrade]

Phone options
  --serial S        device to use (else ANDROID_SERIAL, else the only one connected)
  --package P       app under test; repeat for more (else DUET_PACKAGE or duet.config.json)
  --no-guard        skip the safety checks (a dedicated lab device only)

BROWSER (a visible Chrome per name, e.g. host or guest; it stays open between commands)

  open NAME [URL] [--fake-media] [--fake-video FILE] [--capture-title T] [--size WxH] [--position X,Y]
                                start (or reuse) the browser. Launch flags apply only at start
  goto NAME URL
  click NAME --text T | --selector CSS [--exact]
  fill NAME --field LABEL | --selector CSS (--value V | --value-env VAR)
  press NAME KEY                e.g. Enter, Escape, Tab
  wait-for NAME --text T | --selector CSS [--gone]
  say NAME TEXT                 show a step banner on the page
  screenshot NAME [--label L] [--full-page]
  ui NAME                       buttons, links and fields with their labels
  new-tab NAME --title T [--text X | --html H | --url U]
                                a tab to screen-share with --capture-title T
  eval NAME EXPR [--expect V]   evaluate JavaScript in the page; with --expect, fail unless it equals V
  list                          running browsers
  close NAME

Browser options
  --tab T           act on another tab of that browser, found by title
  --say TEXT        banner text for this step (default: a description of it)
  --timeout MS      how long to wait for the element (default 15000)

SCENARIO (a YAML file of the same commands, one actor per step)

  run FILE          run every step in a fresh folder under runs/, stop at the first failure,
                    collect each actor's screenshot and each phone's logs, write report.html
  check FILE        validate the file without touching any device
  --keep-open       leave the browsers it started open afterwards

REPORT
  report [RUN_DIR]  write RUN_DIR/report.html (default: the current run folder)
  --inline          embed screenshots, for a single file you can send

Common
  --run-dir D       where steps, shots and logs are recorded (default .duet/run)
  --shot            take a screenshot after an action

Every command prints one JSON object. Exit codes: 0 ok, 1 failed, 2 usage, 3 refused by the guard,
4 device problem, 5 not found, 6 timed out.`;

const options = {
  // common
  'run-dir': { type: 'string' },
  shot: { type: 'boolean' },
  label: { type: 'string' },
  text: { type: 'string' },
  exact: { type: 'boolean' },
  gone: { type: 'boolean' },
  timeout: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  // phone
  serial: { type: 'string' },
  package: { type: 'string', multiple: true },
  'no-guard': { type: 'boolean' },
  max: { type: 'string' },
  'max-edge': { type: 'string' },
  all: { type: 'boolean' },
  regex: { type: 'boolean' },
  index: { type: 'string' },
  device: { type: 'boolean' },
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
  // browser
  'fake-media': { type: 'boolean' },
  'fake-video': { type: 'string' },
  'capture-title': { type: 'string' },
  size: { type: 'string' },
  position: { type: 'string' },
  tab: { type: 'string' },
  say: { type: 'string' },
  selector: { type: 'string' },
  field: { type: 'string' },
  value: { type: 'string' },
  'value-env': { type: 'string' },
  'full-page': { type: 'boolean' },
  title: { type: 'string' },
  html: { type: 'string' },
  url: { type: 'string' },
  expect: { type: 'string' },
  // scenario and report
  'keep-open': { type: 'boolean' },
  'runs-dir': { type: 'string' },
  inline: { type: 'boolean' },
  out: { type: 'string' },
} as const satisfies ParseArgsConfig['options'];

export type Values = ReturnType<typeof parse>['values'];

export function parse(argv: string[]) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new DuetError((e as Error).message, 'usage');
  }
}

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new DuetError(`${name} must be a number, got "${v}".`, 'usage');
  return n;
}

function pair(v: string | undefined, name: string, sep: RegExp): [number, number] | undefined {
  if (v === undefined) return undefined;
  const parts = v.split(sep).map(Number);
  if (parts.length !== 2 || !parts.every(Number.isFinite)) throw new DuetError(`${name} looks like 1100x860 or 0,0; got "${v}".`, 'usage');
  return parts as [number, number];
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new DuetError(`Missing ${what}. See "duet --help".`, 'usage');
  return v;
}

/**
 * What a command needs from its caller. The CLI connects and detaches per command;
 * the scenario runner keeps phones and browsers attached for the whole scenario.
 */
export interface CommandContext {
  cfg: DuetConfig;
  run: RunDir;
  registry: BrowserRegistry;
  phone(o: Values): Promise<Phone>;
  browser(name: string, tab: string | undefined): Promise<BrowserActor>;
  /** Called after each browser command with the actor it used. */
  release(actor: BrowserActor): Promise<void>;
  /** Launch options a scenario declared for this browser, merged under the command's own flags. */
  openDefaults?(name: string): Partial<OpenOptions>;
}

// ---- phone --------------------------------------------------------------------

const PHONE_COMMANDS = new Set([
  'devices', 'status', 'screenshot', 'ui', 'wait-for', 'rotation', 'reverse', 'tap', 'swipe', 'type', 'key', 'back', 'open-link', 'launch', 'logs', 'install',
]);

export async function phoneCommand(o: Values, positionals: string[], ctx: CommandContext): Promise<Record<string, unknown>> {
  const [cmd, ...pos] = positionals as [string, ...string[]];
  if (!PHONE_COMMANDS.has(cmd)) throw new DuetError(`Unknown phone command "${cmd}". See "duet --help".`, 'usage');
  if (cmd === 'devices') return { devices: await listDevices() };

  const phone = await ctx.phone(o);
  const shot = o.shot;

  switch (cmd) {
    case 'status': {
      const status = await phone.status();
      const act = evaluateGuard(status, phone.policy, 'act');
      return {
        serial: phone.adb.serial,
        packages: phone.policy.packages,
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
    case 'rotation': {
      if (!o.expect) return { ...(await phone.rotation()) };
      if (o.expect !== 'landscape' && o.expect !== 'portrait') throw new DuetError('--expect is landscape or portrait.', 'usage');
      return { ...(await phone.expectRotation(o.expect, num(o.timeout, '--timeout'))) };
    }
    case 'reverse': {
      const [host, device] = need(pos[0], 'PORT').split(':');
      return { ...(await phone.reverse(num(host, 'PORT')!, num(device, 'device port'))) };
    }
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
      throw new DuetError(`Unknown phone command "${cmd}".`, 'usage');
  }
}

// ---- browser ------------------------------------------------------------------

const BROWSER_COMMANDS = new Set(['open', 'goto', 'click', 'fill', 'press', 'wait-for', 'say', 'screenshot', 'ui', 'new-tab', 'eval', 'list', 'close']);

export async function browserCommand(o: Values, positionals: string[], ctx: CommandContext): Promise<Record<string, unknown>> {
  const [cmd, name, ...pos] = positionals as [string, string | undefined, ...string[]];
  if (!BROWSER_COMMANDS.has(cmd)) throw new DuetError(`Unknown browser command "${cmd}". See "duet --help".`, 'usage');
  const { run, registry } = ctx;

  if (cmd === 'list') {
    const all = Object.values(registry.all());
    const rows = await Promise.all(all.map(async (r) => ({ name: r.name, running: await isAlive(r.port), pid: r.pid, captureTitle: r.captureTitle, fakeMedia: r.fakeMedia })));
    return { browsers: rows };
  }

  const actorName = need(name, 'browser NAME (for example host)');
  const step = { say: o.say, timeoutMs: num(o.timeout, '--timeout'), shot: o.shot };

  if (cmd === 'open') {
    const defaults = ctx.openDefaults?.(actorName) ?? {};
    const { actor, launched } = await BrowserActor.open(actorName, {
      ...defaults,
      url: pos[0] ?? o.url ?? defaults.url,
      fakeMedia: o['fake-media'] ?? defaults.fakeMedia,
      fakeVideo: o['fake-video'] ?? defaults.fakeVideo,
      captureTitle: o['capture-title'] ?? defaults.captureTitle,
      windowSize: pair(o.size, '--size', /x/i) ?? defaults.windowSize,
      windowPosition: pair(o.position, '--position', /,/) ?? defaults.windowPosition,
      run,
      registry,
    });
    try {
      return { name: actorName, launched, url: actor.page.url() };
    } finally {
      await ctx.release(actor);
    }
  }

  const actor = await ctx.browser(actorName, o.tab);
  try {
    switch (cmd) {
      case 'close':
        await actor.close(registry);
        return { closed: actorName };
      case 'goto':
        return { ...(await actor.goto(need(pos[0] ?? o.url, 'URL'), step)) };
      case 'click':
        return { ...(await actor.click({ text: o.text, selector: o.selector, exact: o.exact }, step)) };
      case 'fill': {
        let value = o.value;
        if (o['value-env']) {
          value = process.env[o['value-env']];
          if (value === undefined) throw new DuetError(`Environment variable ${o['value-env']} is not set.`, 'usage');
        }
        if (value === undefined) throw new DuetError('Missing --value or --value-env.', 'usage');
        return { ...(await actor.fill({ text: o.field, selector: o.selector, exact: o.exact }, value, { ...step, secret: !!o['value-env'] })) };
      }
      case 'press':
        return { ...(await actor.press(need(pos[0], 'KEY'), step)) };
      case 'wait-for':
        return { ...(await actor.waitFor({ text: o.text, selector: o.selector, exact: o.exact, gone: o.gone }, step)) };
      case 'say': {
        const text = need(pos.join(' ') || undefined, 'TEXT');
        await actor.say(text);
        run.record({ actor: actorName, action: 'say', args: { text }, ok: true });
        return { said: text };
      }
      case 'screenshot':
        return { ...(await actor.screenshot({ label: o.label, fullPage: o['full-page'] })) };
      case 'ui':
        return { elements: await actor.ui() };
      case 'new-tab':
        return { ...(await actor.newTab({ title: need(o.title, '--title'), text: o.text, html: o.html, url: o.url })) };
      case 'eval': {
        const r = await actor.evaluate(need(pos.join(' ') || undefined, 'EXPR'), o.expect);
        return { ...r };
      }
      default:
        throw new DuetError(`Unknown browser command "${cmd}".`, 'usage');
    }
  } finally {
    if (cmd !== 'close') await ctx.release(actor).catch(() => {});
  }
}
