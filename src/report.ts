import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { RunDir, type RunEvent } from './run.js';
import { DuetError } from './util/errors.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Group {
  step?: { index: number; source: string };
  events: RunEvent[];
}

/** Scenario runs group events under their step; plain CLI runs get one group per event. */
function groupEvents(events: RunEvent[]): Group[] {
  const groups: Group[] = [];
  const hasSteps = events.some((e) => e.actor === 'scenario' && e.action === 'step');
  for (const e of events) {
    if (e.actor === 'scenario') {
      if (e.action === 'step') groups.push({ step: e.args as Group['step'], events: [] });
      else if (e.action === 'evidence') groups.push({ step: { index: 0, source: '' }, events: [] });
      continue;
    }
    if (e.action === 'close') continue;
    if (hasSteps && groups.length) groups[groups.length - 1]!.events.push(e);
    else groups.push({ events: [e] });
  }
  return groups;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function describeEvent(e: RunEvent): string {
  const a = (e.args ?? {}) as Record<string, unknown>;
  const r = (e.result ?? {}) as Record<string, unknown>;
  switch (e.action) {
    case 'tap':
      return a.text ? `tap "${a.text}"${r.x !== undefined ? ` at ${r.x},${r.y}` : ''}` : `tap ${r.x ?? a.x},${r.y ?? a.y}`;
    case 'click':
      return `click ${a.text ? `"${a.text}"` : a.selector}`;
    case 'fill':
      return `fill ${a.text ? `"${a.text}"` : a.selector}`;
    case 'goto':
      return `go to ${a.url}`;
    case 'open-link':
      return `open ${a.uri}`;
    case 'wait-for':
      return `wait for ${a.text ? `"${a.text}"` : a.selector}${a.gone ? ' to go' : ''}`;
    case 'rotation':
      return r.degrees !== undefined ? `rotation ${r.degrees} degrees (${r.landscape ? 'landscape' : 'portrait'})` : 'rotation';
    case 'logs':
      return r.matched !== undefined ? `logs: ${r.matched} of ${r.total} lines matched` : 'logs';
    case 'logs-mark':
      return 'mark the device log';
    case 'screenshot':
      return a.label ? `screenshot (${a.label})` : 'screenshot';
    case 'eval':
      return `eval ${a.expression}${r.value !== undefined ? ` = ${JSON.stringify(r.value)}` : ''}`;
    default:
      return e.action;
  }
}

function imageSrc(run: RunDir, rel: string, inline: boolean): string {
  if (!inline) return rel;
  const path = join(run.dir, rel);
  if (!existsSync(path)) return rel;
  const type = extname(rel) === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${type};base64,${readFileSync(path).toString('base64')}`;
}

function logExcerpt(run: RunDir, e: RunEvent): string {
  const r = (e.result ?? {}) as { lines?: string[]; matched?: number };
  const lines = r.lines ?? [];
  if (!lines.length) return '';
  const shown = lines.slice(-30);
  const more = (r.matched ?? lines.length) - shown.length;
  const link = e.log ? ` <a href="${esc(e.log)}">Full log</a>` : '';
  return `<pre class="log">${esc(shown.join('\n'))}</pre>${more > 0 || link ? `<p class="meta">${more > 0 ? `${more} earlier lines not shown.` : ''}${link}</p>` : ''}`;
}

/** Writes report.html into the run folder and returns its path. */
export function buildReport(runDir: string, opts: { inline?: boolean; out?: string } = {}): string {
  const run = new RunDir(runDir);
  const events = run.events();
  if (!events.length) throw new DuetError(`${runDir} has no events.jsonl, so there is nothing to report.`, 'not-found');

  const start = events.find((e) => e.actor === 'scenario' && e.action === 'start');
  const end = events.find((e) => e.actor === 'scenario' && e.action === 'end');
  const name = (start?.args?.name as string | undefined) ?? 'duet run';
  const actorDefs = (start?.args?.actors ?? {}) as Record<string, { phone?: Record<string, unknown>; browser?: Record<string, unknown> }>;
  const groups = groupEvents(events);
  const failedEvents = events.filter((e) => !e.ok && e.actor !== 'scenario');
  const ok = end ? end.ok : failedEvents.length === 0;
  const total = (end?.args?.total as number | undefined) ?? groups.length;
  const passed = (end?.args?.passed as number | undefined) ?? groups.filter((g) => g.events.every((e) => e.ok)).length;
  const t0 = new Date(events[0]!.t).getTime();
  const t1 = new Date(events[events.length - 1]!.t).getTime();
  const failedGroup = groups.find((g) => g.events.some((e) => !e.ok));

  const actorLine = Object.entries(actorDefs)
    .map(([n, d]) => {
      if (d.phone) return `${esc(n)} (phone${d.phone.package ? `, ${esc([d.phone.package].flat().join(', '))}` : ''})`;
      const b = d.browser ?? {};
      const extras = [b.fakeMedia && 'fake camera and mic', b.captureTitle && `shares the "${esc(b.captureTitle)}" tab`].filter(Boolean);
      return `${esc(n)} (browser${extras.length ? `, ${extras.join(', ')}` : ''})`;
    })
    .join(' · ');

  const summary = ok
    ? `<p class="result">Passed. ${passed} of ${total} steps in ${fmtMs(t1 - t0)}.</p>`
    : `<p class="result failed">Failed at step ${failedGroup?.step?.index ?? '?'} of ${total}.${
        failedGroup ? ` <a href="#step-${failedGroup.step?.index ?? 'x'}">Go to the failure</a>` : ''
      }</p>`;

  const rows = groups
    .map((g, i) => {
      if (g.step?.source.startsWith('note: ') && !g.events.length) {
        return `<li class="note">${esc(g.step.source.slice(6))}</li>`;
      }
      const failed = g.events.find((e) => !e.ok);
      const shots = g.events.filter((e) => e.shot);
      const logs = g.events.filter((e) => e.action === 'logs' && e.ok);
      const ms = g.events.reduce((sum, e) => sum + (e.ms ?? 0), 0);
      const actor = g.events.find((e) => e.actor !== 'scenario')?.actor ?? '';
      const head = g.step
        ? g.step.index
          ? `<span class="num">${g.step.index}</span><code>${esc(g.step.source)}</code>`
          : `<span class="num"></span><span class="actor">Evidence collected after the failure</span>`
        : `<span class="num">${i + 1}</span><span class="actor">${esc(actor)}</span> ${esc(describeEvent(g.events[0]!))}`;
      const detail = g.step
        ? g.events
            .map((e) => `<li>${esc(e.actor)}: ${esc(describeEvent(e))}${e.ms !== undefined ? ` <span class="meta">${fmtMs(e.ms)}</span>` : ''}</li>`)
            .join('')
        : '';
      const images = shots.length
        ? `<div class="shots">${shots
            .map((e) => {
              const src = imageSrc(run, e.shot!, !!opts.inline);
              return `<figure><a href="${esc(src.startsWith('data:') ? '#' : e.shot!)}"><img src="${esc(src)}" alt="${esc(`${e.actor}, ${describeEvent(e)}`)}" loading="lazy"></a><figcaption>${esc(e.actor)}</figcaption></figure>`;
            })
            .join('')}</div>`
        : '';
      return `<li class="step${failed ? ' is-failed' : ''}" id="step-${g.step?.index ?? i + 1}">
  <div class="head">${head}<span class="time">${ms ? fmtMs(ms) : ''}</span></div>
  ${failed ? `<p class="error">${esc(failed.error)}</p>` : ''}
  ${detail ? `<ul class="events">${detail}</ul>` : ''}
  ${logs.map((e) => logExcerpt(run, e)).join('')}
  ${images}
</li>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}</title>
<style>
  :root {
    --text: #1d1d1f; --muted: #5f6368; --line: #e3e3e3; --bg: #ffffff; --code-bg: #f6f6f6;
    --link: #1a5fb4; --fail: #b3261e; --fail-bg: #fdf3f2;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root { --text: #e8e8e8; --muted: #a0a4a8; --line: #333; --bg: #161616; --code-bg: #1f1f1f; --link: #8ab4f8; --fail: #f2b8b5; --fail-bg: #2a1a19; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 400 13px/1.5 var(--sans); }
  main { max-width: 980px; padding: 32px 16px 64px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  .meta, .time { color: var(--muted); font-size: 12px; }
  .result { font-size: 15px; margin: 16px 0 4px; }
  .result.failed { color: var(--fail); font-weight: 600; }
  a { color: var(--link); }
  ol.steps { list-style: none; margin: 24px 0 0; padding: 0; border-top: 1px solid var(--line); }
  .step { padding: 12px 0; border-bottom: 1px solid var(--line); }
  .note { padding: 24px 0 8px 32px; font-weight: 600; border-bottom: 1px solid var(--line); }
  .step.is-failed { background: var(--fail-bg); margin: 0 -12px; padding: 12px; }
  .head { display: flex; gap: 12px; align-items: baseline; }
  .num { color: var(--muted); min-width: 20px; text-align: right; font-variant-numeric: tabular-nums; }
  .head code { font: 13px/1.5 var(--mono); flex: 1; overflow-wrap: anywhere; }
  .actor { font-weight: 600; }
  .time { margin-left: auto; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .error { color: var(--fail); margin: 8px 0 0 32px; overflow-wrap: anywhere; }
  ul.events { list-style: none; margin: 4px 0 0 32px; padding: 0; color: var(--muted); overflow-wrap: anywhere; }
  pre.log { margin: 8px 0 0 32px; padding: 8px 12px; background: var(--code-bg); font: 12px/1.5 var(--mono); overflow-x: auto; white-space: pre; }
  .step > .meta { margin: 4px 0 0 32px; }
  .shots { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0 0 32px; }
  figure { margin: 0; }
  figure img { display: block; max-height: 360px; max-width: 100%; border: 1px solid var(--line); }
  figcaption { color: var(--muted); font-size: 12px; margin-top: 4px; }
  @media (max-width: 600px) {
    .error, ul.events, pre.log, .shots, .step > .meta { margin-left: 0; }
    figure img { max-height: 280px; }
  }
</style>
</head>
<body>
<main>
  <h1>${esc(name)}</h1>
  <p class="meta">${esc(new Date(t0).toLocaleString())}${actorLine ? ` · ${actorLine}` : ''}</p>
  ${summary}
  <ol class="steps">
${rows}
  </ol>
</main>
</body>
</html>
`;
  const out = opts.out ?? join(run.dir, 'report.html');
  writeFileSync(out, html);
  return out;
}
