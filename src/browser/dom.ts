// Functions that run inside the page (passed to page.evaluate / waitForFunction).
// Each must be self-contained: Puppeteer sends the function's source, not its closure.

export interface FindSpec {
  text?: string;
  selector?: string;
  exact?: boolean;
  /** clickable: buttons, links, menu items. field: inputs. any: any element with that text. */
  kind: 'clickable' | 'field' | 'any';
  /** Resolve (with document.body) when nothing matches, for "wait until gone". */
  gone?: boolean;
}

export const BANNER_ID = '__duet_banner';

/** Finds the best visible element for a spec, or null. */
export function pageFind(spec: FindSpec): Element | null {
  const CLICKABLE =
    'button, a[href], [role=button], [role=link], [role=menuitem], [role=menuitemcheckbox], [role=tab], [role=option], [role=checkbox], [role=switch], [role=radio], input[type=submit], input[type=button], input[type=checkbox], input[type=radio], summary, label, [onclick]';
  const FIELD = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=""], [contenteditable=true]';
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const visible = (el: Element) => {
    if (el.closest('#__duet_banner, #__duet_heartbeat')) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0;
  };
  const names = (el: Element): string[] => {
    const out: string[] = [];
    const aria = el.getAttribute('aria-label');
    if (aria) out.push(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) out.push(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
    if (spec.kind === 'field') {
      const f = el as HTMLInputElement;
      if (f.labels) for (const l of Array.from(f.labels)) out.push(l.textContent ?? '');
      const wrap = el.closest('label');
      if (wrap) out.push(wrap.textContent ?? '');
      for (const a of ['placeholder', 'name', 'title']) {
        const v = el.getAttribute(a);
        if (v) out.push(v);
      }
    } else {
      out.push((el as HTMLElement).innerText ?? el.textContent ?? '');
      const v = el.getAttribute('value') ?? el.getAttribute('title') ?? el.getAttribute('alt');
      if (v) out.push(v);
    }
    return out;
  };

  const sel = spec.selector ?? (spec.kind === 'clickable' ? CLICKABLE : spec.kind === 'field' ? FIELD : 'body *');
  const q = norm(spec.text);
  let best: Element | null = null;
  let bestScore = -1;
  let bestArea = Infinity;
  for (const el of Array.from(document.querySelectorAll(sel))) {
    if (!visible(el)) continue;
    let score = 0;
    if (q) {
      score = -1;
      for (const n of names(el).map(norm)) {
        if (n === q) score = Math.max(score, 3);
        else if (!spec.exact && n.startsWith(q)) score = Math.max(score, 2);
        else if (!spec.exact && n.includes(q)) score = Math.max(score, 1);
      }
      if (score < 0) continue;
    }
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (score > bestScore || (score === bestScore && area < bestArea)) {
      best = el;
      bestScore = score;
      bestArea = area;
    }
  }
  if (spec.gone) return best ? null : document.body;
  return best;
}

/** Visible buttons, links and fields with their accessible names, for an agent to scan. */
export function pageInteractive(limit: number): string[] {
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const sel =
    'button, a[href], [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=switch], input:not([type=hidden]), textarea, select, summary';
  const lines: string[] = [];
  for (const el of Array.from(document.querySelectorAll(sel))) {
    if (el.closest('#__duet_banner, #__duet_heartbeat')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') ?? (tag === 'a' ? 'link' : tag === 'input' ? `input[${(el as HTMLInputElement).type}]` : tag);
    const f = el as HTMLInputElement;
    const label =
      el.getAttribute('aria-label') ||
      (f.labels?.length ? norm(f.labels[0]!.textContent) : '') ||
      norm((el as HTMLElement).innerText) ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.getAttribute('name') ||
      '';
    const state: string[] = [];
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') state.push('disabled');
    if (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true' || f.checked) state.push('on');
    if (el.getAttribute('aria-expanded') === 'true') state.push('expanded');
    if ((tag === 'input' || tag === 'textarea') && f.type !== 'checkbox' && f.type !== 'radio' && f.value) {
      state.push(f.type === 'password' ? 'value=***' : `value=${JSON.stringify(f.value.slice(0, 40))}`);
    }
    const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    if (!inView) state.push('offscreen');
    lines.push(`${JSON.stringify(label.slice(0, 80))} ${role}${state.length ? ` [${state.join(',')}]` : ''}`);
    if (lines.length >= limit) break;
  }
  return lines;
}

/** Shows (or updates) the step banner so a person watching knows what the agent is doing. */
export function pageBanner(actor: string, text: string): void {
  let el = document.getElementById('__duet_banner');
  if (!el) {
    el = document.createElement('div');
    el.id = '__duet_banner';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:16px',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'max-width:min(90vw,720px)',
      'background:rgba(24,24,24,.9)',
      'color:#f5f5f5',
      'font:500 13px/1.4 system-ui,-apple-system,sans-serif',
      'padding:7px 12px',
      'border-radius:6px',
      'pointer-events:none',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
    ].join(';');
    document.documentElement.appendChild(el);
  }
  el.textContent = '';
  const who = document.createElement('span');
  who.style.cssText = 'color:#a3a3a3;margin-right:8px';
  who.textContent = actor;
  el.append(who, document.createTextNode(text));
}

export function pageBannerVisible(show: boolean): void {
  const el = document.getElementById('__duet_banner');
  if (el) el.style.visibility = show ? 'visible' : 'hidden';
}
