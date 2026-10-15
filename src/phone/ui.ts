// The uiautomator element tree: parsing a dump and finding elements by their visible text.
// uiautomator only sees what the accessibility layer exposes. Overlays drawn above the
// app's navigator (floating video layers, some game views) can be missing from the dump,
// which then describes the screen underneath. Fall back to a screenshot for those.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface UiNode {
  /** Position in document order, stable for one dump. */
  id: number;
  depth: number;
  parent: number | null;
  text: string;
  desc: string;
  resourceId: string;
  className: string;
  package: string;
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
  selected: boolean;
  checked: boolean;
  bounds: Rect;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[ent] ?? all;
  });
}

function parseBounds(s: string | undefined): Rect {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(s ?? '');
  if (!m) return { left: 0, top: 0, right: 0, bottom: 0 };
  return { left: Number(m[1]), top: Number(m[2]), right: Number(m[3]), bottom: Number(m[4]) };
}

/** Parses `uiautomator dump` XML into a flat list in document order. */
export function parseUiDump(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const stack: number[] = [];
  const tagRe = /<(\/?)node\b([^>]*?)(\/?)>/g;
  for (const m of xml.matchAll(tagRe)) {
    if (m[1]) {
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[2]!.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]!] = decode(a[2]!);
    const node: UiNode = {
      id: nodes.length,
      depth: stack.length,
      parent: stack.length ? stack[stack.length - 1]! : null,
      text: attrs.text ?? '',
      desc: attrs['content-desc'] ?? '',
      resourceId: attrs['resource-id'] ?? '',
      className: attrs.class ?? '',
      package: attrs.package ?? '',
      clickable: attrs.clickable === 'true',
      enabled: attrs.enabled !== 'false',
      focused: attrs.focused === 'true',
      selected: attrs.selected === 'true',
      checked: attrs.checked === 'true',
      bounds: parseBounds(attrs.bounds),
    };
    nodes.push(node);
    if (!m[3]) stack.push(node.id);
  }
  return nodes;
}

export function area(r: Rect): number {
  return Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
}

export function center(r: Rect): { x: number; y: number } {
  return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
}

/** The label a person would read for this element: its text, else its accessibility label. */
export function label(n: UiNode): string {
  return n.text || n.desc;
}

export interface FindOptions {
  /** Only whole-label matches (case-insensitive, whitespace collapsed). */
  exact?: boolean;
  /** Treat the query as a regular expression. */
  regex?: boolean;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Elements whose text or accessibility label matches, best first:
 * whole-label matches, then prefix, then substring; clickable before not; smaller before larger
 * (a button's own label beats the screen container that happens to repeat it).
 * Elements with no on-screen area are skipped.
 */
export function findByText(nodes: UiNode[], query: string, opts: FindOptions = {}): UiNode[] {
  const q = norm(query);
  const re = opts.regex ? new RegExp(query, 'i') : null;
  const scored: { n: UiNode; score: number }[] = [];
  for (const n of nodes) {
    if (area(n.bounds) === 0) continue;
    let best = -1;
    for (const raw of [n.text, n.desc]) {
      if (!raw) continue;
      const v = norm(raw);
      let s = -1;
      if (re) s = re.test(raw) ? 2 : -1;
      else if (v === q) s = 3;
      else if (!opts.exact && v.startsWith(q)) s = 2;
      else if (!opts.exact && v.includes(q)) s = 1;
      best = Math.max(best, s);
    }
    if (best >= 0) scored.push({ n, score: best * 10 + (clickableSelfOrAncestor(nodes, n) ? 1 : 0) });
  }
  scored.sort((a, b) => b.score - a.score || area(a.n.bounds) - area(b.n.bounds) || a.n.id - b.n.id);
  return scored.map((s) => s.n);
}

function clickableSelfOrAncestor(nodes: UiNode[], n: UiNode): boolean {
  for (let cur: UiNode | undefined = n; cur; cur = cur.parent === null ? undefined : nodes[cur.parent]) {
    if (cur.clickable) return true;
  }
  return false;
}

/** A compact, readable line per labelled or clickable element, for an agent to scan. */
export function summarize(nodes: UiNode[], opts: { all?: boolean } = {}): string[] {
  const lines: string[] = [];
  for (const n of nodes) {
    if (area(n.bounds) === 0) continue;
    const name = label(n);
    if (!opts.all && !name && !n.clickable) continue;
    const c = center(n.bounds);
    const flags = [n.clickable && 'clickable', !n.enabled && 'disabled', n.focused && 'focused', n.checked && 'checked', n.selected && 'selected']
      .filter(Boolean)
      .join(',');
    const kind = n.className.split('.').pop() ?? '';
    const id = n.resourceId ? ` #${n.resourceId.split('/').pop()}` : '';
    lines.push(`${JSON.stringify(name)} ${kind}${id} @${c.x},${c.y}${flags ? ` [${flags}]` : ''}`);
  }
  return lines;
}
