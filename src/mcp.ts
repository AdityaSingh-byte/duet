import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BrowserActor, BrowserRegistry } from './browser/browser.js';
import { isAlive } from './browser/chrome.js';
import { loadConfig } from './config.js';
import { listDevices } from './phone/adb.js';
import { evaluateGuard } from './phone/guard.js';
import { Phone } from './phone/phone.js';
import { buildReport } from './report.js';
import { RunDir } from './run.js';
import { runScenario } from './scenario.js';
import { DuetError } from './util/errors.js';

const VERSION = '0.1.0';

/** Finds screenshot files in a result so the client gets the image itself, not just a path. */
function imagesIn(value: unknown, out: string[] = []): string[] {
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && (k === 'path' || k === 'shot') && v.endsWith('.png')) out.push(v);
    else if (v && typeof v === 'object') imagesIn(v, out);
  }
  return out;
}

async function respond(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await fn();
    const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify({ ok: true, ...(value as object) }, null, 1) }];
    for (const path of imagesIn(value)) {
      content.push({ type: 'image', data: readFileSync(path).toString('base64'), mimeType: 'image/png' });
    }
    return { content };
  } catch (e) {
    const err = e instanceof DuetError ? e : new DuetError((e as Error).message ?? String(e));
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ ok: false, code: err.code, error: err.message, ...(err.details ? { details: err.details } : {}) }, null, 1) }],
    };
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * The MCP server: the same phone and browser actors as the CLI, as tools.
 * It stays connected between calls (one phone, any number of named browsers),
 * and returns screenshots as images so the model sees them directly.
 */
export async function startMcpServer(): Promise<void> {
  const cfg = loadConfig();
  let run = RunDir.fromEnv(cfg.runDir);
  const registry = new BrowserRegistry();
  let phoneOpts = {
    serial: cfg.phone?.serial,
    packages: process.env.DUET_PACKAGE?.split(',').map((s) => s.trim()).filter(Boolean) ?? cfg.phone?.packages ?? [],
    noGuard: false,
  };
  let phone: Phone | undefined;
  const browsers = new Map<string, BrowserActor>();

  const getPhone = async () => {
    phone ??= await Phone.connect({ ...phoneOpts, maxEdge: cfg.phone?.maxEdge, settleMs: cfg.phone?.settleMs, run });
    return phone;
  };
  const getBrowser = async (name: string, tab?: string) => {
    if (tab) return BrowserActor.attach(name, { run, registry, tab });
    const cached = browsers.get(name);
    const rec = registry.get(name);
    if (cached && rec && (await isAlive(rec.port))) return cached;
    browsers.delete(name);
    const actor = await BrowserActor.attach(name, { run, registry });
    browsers.set(name, actor);
    return actor;
  };
  const release = async (actor: BrowserActor) => {
    if (browsers.get(actor.name) !== actor) await actor.detach().catch(() => {});
  };
  const withBrowser = <T>(name: string, tab: string | undefined, fn: (b: BrowserActor) => Promise<T>) =>
    respond(async () => {
      const b = await getBrowser(name, tab);
      try {
        return await fn(b);
      } finally {
        await release(b);
      }
    });

  const server = new McpServer({ name: 'duet', version: VERSION });
  const shot = z.boolean().optional().describe('Take a screenshot after the action and return it.');
  const name = z.string().describe('Browser actor name, e.g. host or guest.');
  const tab = z.string().optional().describe('Act on another tab of this browser, found by title.');
  const say = z.string().optional().describe('Banner text shown on the page for this step.');
  const timeoutMs = z.number().optional().describe('How long to wait, in ms.');

  // ---- phone ----------------------------------------------------------------

  server.registerTool(
    'phone_use',
    {
      description:
        'Choose the Android device and the app under test. Taps and typing only happen while one of `packages` is in front. Call before other phone tools if DUET_PACKAGE / duet.config.json does not set them.',
      inputSchema: { serial: z.string().optional(), packages: z.array(z.string()).optional() },
    },
    async (a) =>
      respond(async () => {
        phoneOpts = { ...phoneOpts, ...(a.serial ? { serial: a.serial } : {}), ...(a.packages ? { packages: a.packages } : {}) };
        phone = undefined;
        const p = await getPhone();
        return { serial: p.adb.serial, packages: p.policy.packages, devices: await listDevices() };
      }),
  );

  server.registerTool(
    'phone_status',
    { description: 'What is in front on the phone, whether it is locked or asleep, and whether duet would look or act right now (and why not).' },
    async () =>
      respond(async () => {
        const p = await getPhone();
        const s = await p.status();
        const act = evaluateGuard(s, p.policy, 'act');
        return { serial: p.adb.serial, packages: p.policy.packages, ...s, canObserve: evaluateGuard(s, p.policy, 'observe').ok, canAct: act.ok, reasons: act.reasons };
      }),
  );

  server.registerTool(
    'phone_screenshot',
    {
      description:
        'Screenshot of the phone, scaled so its long edge fits the model. Coordinates you read off this image can be passed straight to phone_tap. Refused while another app is in front or the phone is locked.',
      inputSchema: { label: z.string().optional() },
    },
    async (a) => respond(async () => (await getPhone()).screenshot({ label: a.label })),
  );

  server.registerTool(
    'phone_ui',
    {
      description: 'Elements on the phone screen from uiautomator: label, type, centre (device pixels) and flags. Cannot read screens that never go idle, such as live video.',
      inputSchema: { all: z.boolean().optional().describe('Include unlabelled, non-clickable elements.') },
    },
    async (a) => respond(async () => ({ elements: await (await getPhone()).uiSummary({ all: a.all }) })),
  );

  server.registerTool(
    'phone_tap',
    {
      description:
        'Tap by visible text or accessibility label (`text`), or by coordinates on the LAST phone_screenshot (`x`,`y`). Set `device: true` for raw device pixels. Refused after a rotation until a new screenshot.',
      inputSchema: {
        text: z.string().optional(),
        exact: z.boolean().optional(),
        regex: z.boolean().optional(),
        index: z.number().int().optional().describe('Which match, best first (default 0).'),
        x: z.number().optional(),
        y: z.number().optional(),
        device: z.boolean().optional(),
        shot,
      },
    },
    async (a) =>
      respond(async () => {
        const p = await getPhone();
        if (a.text) return p.tap({ text: a.text, exact: a.exact, regex: a.regex, index: a.index }, { shot: a.shot });
        if (a.x === undefined || a.y === undefined) throw new DuetError('Give text, or x and y.', 'usage');
        return p.tap({ x: a.x, y: a.y, space: a.device ? 'device' : 'image' }, { shot: a.shot });
      }),
  );

  server.registerTool(
    'phone_swipe',
    {
      description: 'Swipe between two points on the last screenshot (or device pixels with `device: true`).',
      inputSchema: { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), ms: z.number().optional(), device: z.boolean().optional(), shot },
    },
    async (a) =>
      respond(async () =>
        (await getPhone()).swipe({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, { ms: a.ms, space: a.device ? 'device' : 'image', shot: a.shot }),
      ),
  );

  server.registerTool(
    'phone_type',
    { description: 'Type ASCII text into the focused field.', inputSchema: { text: z.string(), shot } },
    async (a) => respond(async () => (await getPhone()).type(a.text, { shot: a.shot })),
  );

  server.registerTool(
    'phone_key',
    { description: 'Press a key: BACK, ENTER, TAB, HOME, or any KEYCODE_* name.', inputSchema: { key: z.string(), shot } },
    async (a) => respond(async () => (await getPhone()).key(a.key, { shot: a.shot })),
  );

  server.registerTool(
    'phone_open_link',
    { description: 'Open a deep link or web URL with a VIEW intent, in the app under test unless `package` says otherwise.', inputSchema: { uri: z.string(), package: z.string().optional(), shot } },
    async (a) => respond(async () => (await getPhone()).openLink(a.uri, { package: a.package, shot: a.shot })),
  );

  server.registerTool(
    'phone_launch',
    { description: 'Start the app under test (or `package`) from its launcher activity.', inputSchema: { package: z.string().optional(), shot } },
    async (a) => respond(async () => (await getPhone()).launch({ package: a.package, shot: a.shot })),
  );

  server.registerTool(
    'phone_wait_for',
    { description: 'Wait until an element with this text appears (or, with `gone`, disappears).', inputSchema: { text: z.string(), gone: z.boolean().optional(), exact: z.boolean().optional(), timeoutMs } },
    async (a) => respond(async () => (await getPhone()).waitFor({ text: a.text, gone: a.gone, exact: a.exact, timeoutMs: a.timeoutMs })),
  );

  server.registerTool(
    'phone_rotation',
    {
      description: 'Display rotation (0-3), degrees, and whether the phone is in landscape. With `expect`, wait up to timeoutMs for that orientation, else fail.',
      inputSchema: { expect: z.enum(['landscape', 'portrait']).optional(), timeoutMs },
    },
    async (a) => respond(async () => (a.expect ? (await getPhone()).expectRotation(a.expect, a.timeoutMs) : (await getPhone()).rotation())),
  );

  server.registerTool(
    'phone_unstick',
    {
      description:
        'Release injected touches another tool left pressed. Use when taps fail with "Android rejected the injected input" and a stuck pointer; until released, Android rejects every injected tap.',
    },
    async () => respond(async () => (await getPhone()).unstick()),
  );

  server.registerTool(
    'phone_reverse',
    { description: "Let the phone reach a port on this computer as localhost (adb reverse), e.g. a dev server.", inputSchema: { port: z.number().int(), devicePort: z.number().int().optional() } },
    async (a) => respond(async () => (await getPhone()).reverse(a.port, a.devicePort)),
  );

  server.registerTool(
    'phone_logs_mark',
    { description: 'Remember "now" on the device clock. Call right before an action, then phone_logs with sinceMark to see only what that action logged.' },
    async () => respond(async () => (await getPhone()).markLogs()),
  );

  server.registerTool(
    'phone_logs',
    {
      description:
        'Read logcat without clearing it. Logs show what screenshots miss: a view that opened and closed within 100 ms, a crash, a rejected intent. The full capture is saved to the run folder.',
      inputSchema: {
        sinceMark: z.boolean().optional(),
        grep: z.string().optional().describe('Case-insensitive regular expression.'),
        app: z.boolean().optional().describe("Only the app under test's process."),
        max: z.number().optional().describe('Most recent matching lines to return (default 200).'),
      },
    },
    async (a) => respond(async () => (await getPhone()).logs({ sinceMark: a.sinceMark, grep: a.grep, app: a.app, max: a.max })),
  );

  server.registerTool(
    'phone_install',
    {
      description:
        'Install an APK over the existing app, keeping its data. With `resign`, re-sign it first with the keystore the installed copy was signed with (the debug keystore by default). Never uninstalls.',
      inputSchema: {
        apk: z.string(),
        resign: z.boolean().optional(),
        keystore: z.string().optional(),
        storePass: z.string().optional().describe('apksigner spec: pass:..., env:VAR or file:path.'),
        alias: z.string().optional(),
        downgrade: z.boolean().optional(),
      },
    },
    async (a) =>
      respond(async () =>
        (await getPhone()).install(a.apk, {
          resign: a.resign ? { keystore: a.keystore, storePass: a.storePass, alias: a.alias } : undefined,
          downgrade: a.downgrade,
        }),
      ),
  );

  // ---- browser ----------------------------------------------------------------

  server.registerTool(
    'browser_open',
    {
      description:
        'Start a visible Chrome for a named actor (its own profile, so sign-ins persist), or reuse it if running. `fakeMedia` gives a fake camera and mic with no prompts. `captureTitle` makes screen sharing pick the tab with that title (open it with browser_new_tab). Launch options apply only when Chrome starts.',
      inputSchema: {
        name,
        url: z.string().optional(),
        fakeMedia: z.boolean().optional(),
        captureTitle: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      },
    },
    async (a) =>
      respond(async () => {
        const { actor, launched } = await BrowserActor.open(a.name, {
          url: a.url,
          fakeMedia: a.fakeMedia,
          captureTitle: a.captureTitle,
          windowSize: a.width && a.height ? [a.width, a.height] : undefined,
          run,
          registry,
        });
        browsers.set(a.name, actor);
        return { name: a.name, launched, url: actor.page.url() };
      }),
  );

  server.registerTool(
    'browser_goto',
    { description: 'Navigate a browser actor to a URL.', inputSchema: { name, url: z.string(), say, shot } },
    async (a) => withBrowser(a.name, undefined, (b) => b.goto(a.url, { say: a.say, shot: a.shot })),
  );

  server.registerTool(
    'browser_click',
    {
      description: 'Click the best visible button, link or menu item whose label contains `text` (or that matches `selector`). Shows a banner first.',
      inputSchema: { name, text: z.string().optional(), selector: z.string().optional(), exact: z.boolean().optional(), tab, say, timeoutMs, shot },
    },
    async (a) => withBrowser(a.name, a.tab, (b) => b.click({ text: a.text, selector: a.selector, exact: a.exact }, { say: a.say, timeoutMs: a.timeoutMs, shot: a.shot })),
  );

  server.registerTool(
    'browser_fill',
    {
      description: 'Replace the value of the field labelled `field` (label, aria-label, placeholder or name) or matching `selector`. Use `valueEnv` for secrets so they never appear in the transcript.',
      inputSchema: { name, field: z.string().optional(), selector: z.string().optional(), value: z.string().optional(), valueEnv: z.string().optional(), tab, say, timeoutMs, shot },
    },
    async (a) =>
      withBrowser(a.name, a.tab, (b) => {
        const value = a.valueEnv ? process.env[a.valueEnv] : a.value;
        if (value === undefined) throw new DuetError(a.valueEnv ? `${a.valueEnv} is not set.` : 'Give value or valueEnv.', 'usage');
        return b.fill({ text: a.field, selector: a.selector }, value, { say: a.say, timeoutMs: a.timeoutMs, shot: a.shot, secret: !!a.valueEnv });
      }),
  );

  server.registerTool(
    'browser_press',
    { description: 'Press a key in the page: Enter, Escape, Tab, ArrowDown...', inputSchema: { name, key: z.string(), tab, say, shot } },
    async (a) => withBrowser(a.name, a.tab, (b) => b.press(a.key, { say: a.say, shot: a.shot })),
  );

  server.registerTool(
    'browser_wait_for',
    { description: 'Wait until text (or a selector) is visible in the page, or with `gone`, until it is not.', inputSchema: { name, text: z.string().optional(), selector: z.string().optional(), gone: z.boolean().optional(), tab, timeoutMs } },
    async (a) => withBrowser(a.name, a.tab, (b) => b.waitFor({ text: a.text, selector: a.selector, gone: a.gone }, { timeoutMs: a.timeoutMs })),
  );

  server.registerTool(
    'browser_say',
    { description: 'Show a step banner on the page, so a person watching knows what is happening.', inputSchema: { name, text: z.string(), tab } },
    async (a) =>
      withBrowser(a.name, a.tab, async (b) => {
        await b.say(a.text);
        run.record({ actor: a.name, action: 'say', args: { text: a.text }, ok: true });
        return { said: a.text };
      }),
  );

  server.registerTool(
    'browser_front',
    { description: 'Bring a browser actor\'s page (or a tab) to the front. Chrome switches to a tab when another page starts sharing it.', inputSchema: { name, tab } },
    async (a) => withBrowser(a.name, a.tab, (b) => b.front()),
  );

  server.registerTool(
    'browser_screenshot',
    { description: 'Screenshot of a browser actor (banner hidden), returned as an image.', inputSchema: { name, label: z.string().optional(), fullPage: z.boolean().optional(), tab } },
    async (a) => withBrowser(a.name, a.tab, (b) => b.screenshot({ label: a.label, fullPage: a.fullPage })),
  );

  server.registerTool(
    'browser_ui',
    { description: 'Visible buttons, links and fields in the page, with their labels and state.', inputSchema: { name, tab } },
    async (a) => withBrowser(a.name, a.tab, async (b) => ({ elements: await b.ui() })),
  );

  server.registerTool(
    'browser_new_tab',
    {
      description: 'Open a helper tab in a browser actor, such as the slides a host shares (pair with captureTitle). Without html or url it shows `text` as a plain slide.',
      inputSchema: { name, title: z.string(), text: z.string().optional(), html: z.string().optional(), url: z.string().optional() },
    },
    async (a) => withBrowser(a.name, undefined, (b) => b.newTab({ title: a.title, text: a.text, html: a.html, url: a.url })),
  );

  server.registerTool(
    'browser_eval',
    { description: 'Evaluate a JavaScript expression in the page and return its JSON value. With `expect`, fail unless it equals that.', inputSchema: { name, expression: z.string(), expect: z.string().optional(), tab } },
    async (a) => withBrowser(a.name, a.tab, (b) => b.evaluate(a.expression, a.expect)),
  );

  server.registerTool('browser_list', { description: 'Browser actors duet has started, and whether each is still running.' }, async () =>
    respond(async () => ({
      browsers: await Promise.all(Object.values(registry.all()).map(async (r) => ({ name: r.name, running: await isAlive(r.port), captureTitle: r.captureTitle, fakeMedia: r.fakeMedia }))),
    })),
  );

  server.registerTool('browser_close', { description: 'Close a browser actor.', inputSchema: { name } }, async (a) =>
    respond(async () => {
      const b = await getBrowser(a.name);
      browsers.delete(a.name);
      await b.close(registry);
      return { closed: a.name };
    }),
  );

  // ---- runs -------------------------------------------------------------------

  server.registerTool(
    'run_new',
    { description: 'Start a fresh run folder (runs/<time>-<name>) for the steps that follow, so report_build covers just them.', inputSchema: { name: z.string() } },
    async (a) =>
      respond(async () => {
        const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'run';
        run = new RunDir(join('runs', `${stamp()}-${slug}`));
        phone = undefined;
        for (const b of browsers.values()) await b.detach().catch(() => {});
        browsers.clear();
        return { runDir: run.dir };
      }),
  );

  server.registerTool(
    'report_build',
    { description: 'Write report.html for the current run (or `runDir`): every step, its screenshots and log excerpts, failures first.', inputSchema: { runDir: z.string().optional(), inline: z.boolean().optional() } },
    async (a) => respond(async () => ({ report: buildReport(a.runDir ?? run.dir, { inline: a.inline }) })),
  );

  server.registerTool(
    'scenario_run',
    {
      description: 'Run a scenario file end to end in its own run folder. Stops at the first failure, collects screenshots and phone logs, and writes report.html.',
      inputSchema: { file: z.string(), keepOpen: z.boolean().optional() },
    },
    async (a) =>
      respond(async () => {
        for (const b of browsers.values()) await b.detach().catch(() => {});
        browsers.clear();
        const result = await runScenario(a.file, { cfg, keepOpen: a.keepOpen });
        return { ...result, report: buildReport(result.runDir) };
      }),
  );

  await server.connect(new StdioServerTransport());
}
