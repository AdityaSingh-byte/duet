import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import puppeteer, { type Browser, type ElementHandle, type KeyInput, type Page } from 'puppeteer-core';
import { RunDir } from '../run.js';
import { DuetError } from '../util/errors.js';
import { downscalePng } from '../util/png.js';
import { isAlive, launchChrome, type ChromeLaunchOptions } from './chrome.js';
import { pageBanner, pageBannerVisible, pageFind, pageInteractive, type FindSpec } from './dom.js';

/** What duet remembers about a running browser between commands (.duet/browsers.json). */
export interface BrowserRecord {
  name: string;
  pid: number;
  port: number;
  profileDir: string;
  mainTarget?: string;
  fakeMedia?: boolean;
  captureTitle?: string;
  startedAt: string;
}

export class BrowserRegistry {
  constructor(readonly path = join('.duet', 'browsers.json')) {}

  all(): Record<string, BrowserRecord> {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, BrowserRecord>;
    } catch {
      return {};
    }
  }

  get(name: string): BrowserRecord | undefined {
    return this.all()[name];
  }

  set(rec: BrowserRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ ...this.all(), [rec.name]: rec }, null, 2));
  }

  delete(name: string): void {
    const all = this.all();
    delete all[name];
    if (existsSync(this.path)) writeFileSync(this.path, JSON.stringify(all, null, 2));
  }
}

export interface OpenOptions extends Omit<ChromeLaunchOptions, 'profileDir'> {
  url?: string;
  /** Profiles live here, one folder per actor name, so sign-ins survive between runs. */
  profilesDir?: string;
  run?: RunDir;
  registry?: BrowserRegistry;
}

export interface Target {
  text?: string;
  selector?: string;
  exact?: boolean;
}

export interface StepOptions {
  /** Banner text shown before the step. Defaults to a description of the step. */
  say?: string;
  timeoutMs?: number;
  shot?: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

async function targetId(page: Page): Promise<string> {
  const s = await page.createCDPSession();
  try {
    const { targetInfo } = await s.send('Target.getTargetInfo');
    return targetInfo.targetId;
  } finally {
    await s.detach().catch(() => {});
  }
}

function describe(t: Target): string {
  return t.text ? `"${t.text}"` : (t.selector ?? '?');
}

/**
 * One named browser actor ("host", "guest"): a visible Chrome with its own profile.
 * Chrome keeps running between commands; each command attaches, acts, records and detaches.
 */
export class BrowserActor {
  private constructor(
    readonly name: string,
    readonly browser: Browser,
    readonly page: Page,
    readonly run: RunDir,
    private readonly maxEdge: number,
  ) {}

  /** Starts the named browser, or attaches to it if it is already running. */
  static async open(name: string, opts: OpenOptions = {}): Promise<{ actor: BrowserActor; launched: boolean }> {
    if (!NAME_RE.test(name)) throw new DuetError(`Browser name "${name}" should be a short word such as host or guest.`, 'usage');
    const registry = opts.registry ?? new BrowserRegistry();
    const run = opts.run ?? RunDir.fromEnv();
    const existing = registry.get(name);
    if (existing && (await isAlive(existing.port))) {
      const changed =
        (opts.captureTitle !== undefined && opts.captureTitle !== existing.captureTitle) ||
        (opts.fakeMedia !== undefined && opts.fakeMedia !== !!existing.fakeMedia);
      if (changed) {
        throw new DuetError(`"${name}" is already open with other launch flags. Run "duet browser close ${name}" first.`, 'usage');
      }
      const actor = await BrowserActor.attach(name, { run, registry });
      if (opts.url) await actor.goto(opts.url);
      return { actor, launched: false };
    }
    const profileDir = join(opts.profilesDir ?? join('.duet', 'profiles'), name);
    const chrome = await launchChrome({ ...opts, profileDir });
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    registry.set({
      name,
      pid: chrome.pid,
      port: chrome.port,
      profileDir,
      mainTarget: await targetId(page),
      fakeMedia: !!(opts.fakeMedia || opts.fakeVideo),
      captureTitle: opts.captureTitle,
      startedAt: new Date().toISOString(),
    });
    const actor = new BrowserActor(name, browser, page, run, 1568);
    run.record({ actor: name, action: 'open', args: { fakeMedia: !!opts.fakeMedia, captureTitle: opts.captureTitle }, ok: true, result: { pid: chrome.pid } });
    if (opts.url) await actor.goto(opts.url);
    return { actor, launched: true };
  }

  /** Attaches to a running named browser. `tab` picks another tab by (part of) its title. */
  static async attach(name: string, opts: { run?: RunDir; registry?: BrowserRegistry; tab?: string; maxEdge?: number } = {}): Promise<BrowserActor> {
    const registry = opts.registry ?? new BrowserRegistry();
    const rec = registry.get(name);
    if (!rec || !(await isAlive(rec.port))) {
      if (rec) registry.delete(name);
      throw new DuetError(`Browser "${name}" is not running. Start it with "duet browser open ${name} <url>".`, 'not-found');
    }
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${rec.port}`, defaultViewport: null });
    const pages = await browser.pages();
    let page: Page | undefined;
    if (opts.tab) {
      const want = opts.tab.toLowerCase();
      for (const p of pages) if ((await p.title()).toLowerCase().includes(want)) page = p;
      if (!page) {
        await browser.disconnect();
        throw new DuetError(`No tab in "${name}" has "${opts.tab}" in its title.`, 'not-found');
      }
    } else {
      for (const p of pages) if ((await targetId(p)) === rec.mainTarget) page = p;
      if (!page) {
        page = pages[0] ?? (await browser.newPage());
        registry.set({ ...rec, mainTarget: await targetId(page) });
      }
    }
    return new BrowserActor(name, browser, page, opts.run ?? RunDir.fromEnv(), opts.maxEdge ?? 1568);
  }

  /** Lets go of the browser; it keeps running for the next command. */
  async detach(): Promise<void> {
    await this.browser.disconnect();
  }

  async close(registry = new BrowserRegistry()): Promise<void> {
    await this.step('close', {}, async () => {
      await this.browser.close().catch(() => {});
      registry.delete(this.name);
      return { result: { closed: this.name } };
    });
  }

  // ---- steps --------------------------------------------------------------

  async say(text: string): Promise<void> {
    await this.page.evaluate(pageBanner, this.name, text).catch(() => {});
  }

  async goto(url: string, opts: StepOptions = {}) {
    return this.step('goto', { url }, async () => {
      await this.page.bringToFront();
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs ?? 45_000 });
      await this.page.waitForNetworkIdle({ idleTime: 400, timeout: 8_000 }).catch(() => {});
      await this.say(opts.say ?? `opened ${new URL(url).pathname}`);
      return this.withShot({ url: this.page.url(), title: await this.page.title() }, opts, 'after-goto');
    });
  }

  /** Clicks the best visible button, link or menu item whose label contains the text (or matches the selector). */
  async click(t: Target, opts: StepOptions = {}) {
    return this.step('click', { ...t }, async () => {
      await this.say(opts.say ?? `click ${describe(t)}`);
      const el = await this.find({ ...t, kind: 'clickable' }, opts.timeoutMs);
      const label = await el.evaluate((e) => ((e as HTMLElement).innerText || e.getAttribute('aria-label') || '').trim().slice(0, 80));
      await el.click();
      await el.dispose();
      return this.withShot({ clicked: label || describe(t) }, opts, 'after-click');
    });
  }

  /** Replaces the value of the field labelled `t.text` (label, aria-label, placeholder or name). */
  async fill(t: Target, value: string, opts: StepOptions & { secret?: boolean } = {}) {
    return this.step('fill', { ...t, value: opts.secret ? '***' : value }, async () => {
      await this.say(opts.say ?? `fill ${describe(t)}`);
      const el = await this.find({ ...t, kind: 'field' }, opts.timeoutMs);
      await el.evaluate((e) => {
        const f = e as HTMLInputElement;
        f.focus();
        if (typeof f.select === 'function') f.select();
        else document.execCommand('selectAll');
      });
      await this.page.keyboard.press('Backspace');
      await el.type(value, { delay: 15 });
      await el.dispose();
      return this.withShot({ filled: describe(t) }, opts, 'after-fill');
    });
  }

  async press(key: string, opts: StepOptions = {}) {
    return this.step('press', { key }, async () => {
      await this.say(opts.say ?? `press ${key}`);
      await this.page.keyboard.press(key as KeyInput);
      return this.withShot({ pressed: key }, opts, 'after-press');
    });
  }

  async waitFor(t: Target & { gone?: boolean }, opts: StepOptions = {}) {
    return this.step('wait-for', { ...t }, async () => {
      const started = Date.now();
      if (opts.say) await this.say(opts.say);
      const kind: FindSpec['kind'] = 'any';
      try {
        await this.page.waitForFunction(pageFind, { timeout: opts.timeoutMs ?? 15_000, polling: 250 }, { ...t, kind, gone: t.gone });
      } catch (e) {
        if ((e as Error).name === 'TimeoutError') {
          throw new DuetError(`${describe(t)} ${t.gone ? 'is still on the page' : 'did not appear'} after ${opts.timeoutMs ?? 15_000} ms.`, 'timeout');
        }
        throw e;
      }
      return this.withShot({ ms: Date.now() - started }, opts, t.gone ? 'gone' : 'appeared');
    });
  }

  async screenshot(opts: { label?: string; fullPage?: boolean } = {}) {
    return this.step('screenshot', { label: opts.label }, async () => {
      const shot = await this.capture(opts.label, opts.fullPage);
      return { result: shot, shot: shot.path };
    });
  }

  /**
   * Brings this page (or the tab picked with --tab) to the front. Chrome switches to a tab when
   * another page starts sharing it; a presenter goes back to their own page.
   */
  async front() {
    return this.step('front', {}, async () => {
      await this.page.bringToFront();
      return { result: { front: await this.page.title() } };
    });
  }

  /** Visible buttons, links and fields with their labels. */
  async ui(limit = 120): Promise<string[]> {
    return this.step('ui', {}, async () => ({ result: await this.page.evaluate(pageInteractive, limit) }));
  }

  /**
   * Opens a helper tab, for example the page a host shares with --capture-title.
   * Without html or url it shows the title as a plain slide.
   */
  async newTab(o: { title: string; text?: string; html?: string; url?: string }) {
    return this.step('new-tab', { title: o.title, url: o.url }, async () => {
      const tab = await this.browser.newPage();
      if (o.url) await tab.goto(o.url, { waitUntil: 'domcontentloaded' });
      else {
        const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
        await tab.setContent(
          o.html ??
            `<!doctype html><title>${esc(o.title)}</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:#f4f1ea;color:#1f2933;font:600 56px/1.2 system-ui,sans-serif;text-align:center;padding:0 6vw">${esc(o.text ?? o.title)}</body>`,
        );
      }
      await this.page.bringToFront();
      return { result: { title: await tab.title() } };
    });
  }

  /** Evaluates a JavaScript expression in the page and returns its JSON value. */
  async evaluate(expression: string, expect?: string) {
    return this.step('eval', { expression: expression.slice(0, 200), expect }, async () => {
      const value: unknown = await this.page.evaluate(expression);
      if (expect !== undefined) {
        const got = typeof value === 'string' ? value : JSON.stringify(value);
        if (got !== expect) throw new DuetError(`Expected ${JSON.stringify(expect)}, got ${JSON.stringify(got)}.`, 'failed', { value });
      }
      return { result: { value } };
    });
  }

  // ---- helpers ------------------------------------------------------------

  private async find(spec: FindSpec, timeoutMs = 15_000): Promise<ElementHandle<Element>> {
    if (!spec.text && !spec.selector) throw new DuetError('Give --text or --selector.', 'usage');
    try {
      const handle = await this.page.waitForFunction(pageFind, { timeout: timeoutMs, polling: 200 }, spec);
      const el = handle.asElement() as ElementHandle<Element> | null;
      if (!el) throw new Error('not an element');
      return el;
    } catch (e) {
      if ((e as Error).name !== 'TimeoutError') throw e;
      const onPage = await this.page.evaluate(pageInteractive, 40).catch(() => []);
      throw new DuetError(`No visible ${spec.kind === 'field' ? 'field' : 'button or link'} matches ${describe(spec)} after ${timeoutMs} ms.`, 'not-found', {
        onPage,
      });
    }
  }

  private async capture(label?: string, fullPage = false) {
    await this.page.evaluate(pageBannerVisible, false).catch(() => {});
    let raw: Buffer;
    try {
      raw = Buffer.from(await this.page.screenshot({ type: 'png', fullPage }));
    } finally {
      await this.page.evaluate(pageBannerVisible, true).catch(() => {});
    }
    const scaled = downscalePng(raw, this.maxEdge);
    const path = this.run.nextPath('shots', this.name, label, 'png');
    this.run.write(path, scaled.png);
    return { path, image: [scaled.width, scaled.height] as [number, number] };
  }

  private async withShot<T extends object>(result: T, opts: StepOptions, label: string): Promise<{ result: T & { shot?: string }; shot?: string }> {
    if (!opts.shot) return { result };
    await new Promise((r) => setTimeout(r, 400));
    const shot = await this.capture(label);
    return { result: { ...result, shot: shot.path }, shot: shot.path };
  }

  private step<T>(action: string, args: Record<string, unknown>, fn: () => Promise<{ result: T; shot?: string; log?: string }>): Promise<T> {
    return this.run.step(this.name, action, args, fn);
  }
}
