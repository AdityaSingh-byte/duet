import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome } from './browser/chrome.js';
import type { Track } from './record.js';
import { RunDir, type RunEvent } from './run.js';
import { DuetError } from './util/errors.js';

const PANE_H = 900;
const GAP = 24;
const MARGIN = 24;
const HEADER_H = 56;
const FOOTER_H = 88;
const BG = '161616';
/** Status bar height on the phone, cropped out so the owner's notification icons stay private. */
const STATUS_BAR_FRACTION = 0.04;

interface Caption {
  from: number;
  to: number;
  html: string;
}

function ffprobeSize(path: string): Promise<[number, number]> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => {
      const [w, h] = out.trim().split('\n')[0]!.split(',').map(Number);
      if (code !== 0 || !w || !h) reject(new DuetError(`ffprobe could not read ${path}.`, 'failed'));
      else resolve([w, h]);
    });
  });
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT' ? new DuetError('ffmpeg not found. Install it to make run videos (brew install ffmpeg).', 'not-found') : e),
    );
    p.on('close', (code) => (code === 0 ? resolve() : reject(new DuetError(`ffmpeg failed: ${err.trim().split('\n').pop()}`, 'failed'))));
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Captions from the scenario's step events: the current step, notes as headings, the result at the end. */
function captionsFrom(events: RunEvent[], t0: number, end: number): Caption[] {
  const steps = events.filter((e) => e.actor === 'scenario' && e.action === 'step');
  const caps: Caption[] = [];
  steps.forEach((e, i) => {
    const a = e.args as { index: number; source: string };
    const from = (new Date(e.t).getTime() - t0) / 1000;
    const next = steps[i + 1];
    const to = next ? (new Date(next.t).getTime() - t0) / 1000 : end;
    if (a.source.startsWith('note: ')) {
      caps.push({ from, to, html: `<span class="note">${esc(a.source.slice(6))}</span>` });
    } else {
      const [actor, ...rest] = a.source.split(': ');
      caps.push({ from, to, html: `<span class="num">${a.index}</span><span class="actor">${esc(actor!)}</span><code>${esc(rest.join(': '))}</code>` });
    }
  });
  return caps;
}

function resultCaption(events: RunEvent[]): string {
  const endEv = events.find((e) => e.actor === 'scenario' && e.action === 'end');
  if (!endEv) return '';
  const a = endEv.args as { passed: number; total: number };
  if (endEv.ok) return `<span class="pass">Passed</span><span class="plain">${a.passed} of ${a.total} steps</span>`;
  return `<span class="fail">Failed</span><span class="plain">${esc(endEv.error ?? '')}</span>`;
}

async function renderPngs(width: number, header: { html: string }, captions: { html: string; file: string }[], headerFile: string) {
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-first-run'] });
  try {
    const page = await browser.newPage();
    const css = `
      * { margin: 0; box-sizing: border-box; }
      body { background: #${BG}; color: #f2f2f2; font: 500 26px/1.3 system-ui, -apple-system, sans-serif; }
      .bar { width: ${width}px; display: flex; align-items: center; gap: 18px; padding: 0 ${MARGIN + 8}px; white-space: nowrap; overflow: hidden; }
      .num { color: #8a8a8a; min-width: 36px; text-align: right; font-variant-numeric: tabular-nums; }
      .actor { font-weight: 650; }
      code { font: 500 24px ui-monospace, "SF Mono", Menlo, monospace; color: #e6e6e6; overflow: hidden; text-overflow: ellipsis; }
      .note { color: #cfcfcf; font-weight: 600; }
      .pass { color: #7ed49a; font-weight: 700; }
      .fail { color: #ff8a80; font-weight: 700; }
      .plain { color: #e6e6e6; overflow: hidden; text-overflow: ellipsis; }
      .label { position: absolute; top: 0; height: ${HEADER_H}px; display: flex; align-items: center; justify-content: center; color: #bdbdbd; font-size: 22px; }
      .label b { color: #f2f2f2; font-weight: 650; margin-right: 10px; }`;
    await page.setViewport({ width, height: HEADER_H, deviceScaleFactor: 1 });
    await page.setContent(`<style>${css}</style><div style="position:relative;width:${width}px;height:${HEADER_H}px">${header.html}</div>`);
    await page.screenshot({ path: headerFile as `${string}.png`, clip: { x: 0, y: 0, width, height: HEADER_H } });
    await page.setViewport({ width, height: FOOTER_H, deviceScaleFactor: 1 });
    for (const c of captions) {
      await page.setContent(`<style>${css}</style><div class="bar" style="height:${FOOTER_H}px">${c.html}</div>`);
      await page.screenshot({ path: c.file as `${string}.png`, clip: { x: 0, y: 0, width, height: FOOTER_H } });
    }
  } finally {
    await browser.close();
  }
}

/**
 * Builds video/run.mp4 from a run's recordings: browsers on the left, phones on the right, lined
 * up by the time each recording started, with the current step as a caption and the result at
 * the end. With `gif`, also writes video/run.gif for a README.
 */
export async function composeRunVideo(runDir: string, opts: { gif?: boolean } = {}): Promise<{ mp4: string; gif?: string; seconds: number }> {
  const run = new RunDir(runDir);
  const tracksFile = join(run.dir, 'video', 'tracks.json');
  if (!existsSync(tracksFile)) throw new DuetError(`${runDir} has no recordings. Run the scenario with --record.`, 'not-found');
  const tracks = (JSON.parse(readFileSync(tracksFile, 'utf8')) as Track[]).filter((t) => existsSync(t.path));
  if (!tracks.length) throw new DuetError('The recordings listed in tracks.json are missing.', 'not-found');
  // Browsers first (the presenter), then phones.
  tracks.sort((a, b) => (a.kind === b.kind ? a.startedAt - b.startedAt : a.kind === 'browser' ? -1 : 1));

  const events = run.events();
  const t0 = Math.min(...tracks.map((t) => t.startedAt));
  const endEv = events.find((e) => e.actor === 'scenario' && e.action === 'end');
  const tail = 3;
  const end = ((endEv ? new Date(endEv.t).getTime() : Date.now()) - t0) / 1000 + tail;

  // Scaled pane widths, to place the labels and size the captions.
  const widths: number[] = [];
  for (const t of tracks) {
    const [w, h] = await ffprobeSize(t.path);
    const ch = t.kind === 'phone' ? h * (1 - STATUS_BAR_FRACTION) : h;
    widths.push(2 * Math.round((w * PANE_H) / ch / 2));
  }
  const width = MARGIN * 2 + widths.reduce((a, b) => a + b, 0) + GAP * (tracks.length - 1);

  let x = MARGIN;
  const labels = tracks
    .map((t, i) => {
      const html = `<div class="label" style="left:${x}px;width:${widths[i]}px"><b>${esc(t.actor)}</b>${t.kind === 'phone' ? 'Android phone' : 'Chrome'}</div>`;
      x += widths[i]! + GAP;
      return html;
    })
    .join('');

  const capDir = join(run.dir, 'video', 'captions');
  mkdirSync(capDir, { recursive: true });
  const caps = captionsFrom(events, t0, end - tail);
  const result = resultCaption(events);
  if (result) caps.push({ from: end - tail, to: end, html: result });
  const capFiles = caps.map((c, i) => ({ ...c, file: join(capDir, `${String(i).padStart(3, '0')}.png`) }));
  const headerFile = join(capDir, 'header.png');
  await renderPngs(width, { html: labels }, capFiles, headerFile);

  // Pass 1: each track trimmed to the shared clock, scaled to the pane height, stacked and framed.
  // Pass 2: the header and the captions on top. Doing it in one graph fails on ffmpeg 8 with real
  // phone and screencast input (frame crop metadata leaks through the overlays), so the stacked
  // video is written out once and overlaid as a clean file.
  const inputs: string[] = [];
  const chains: string[] = [];
  tracks.forEach((t, i) => {
    inputs.push('-i', t.path);
    const offset = ((t.startedAt - t0) / 1000).toFixed(3);
    const crop = t.kind === 'phone' ? `crop=iw:ih*${1 - STATUS_BAR_FRACTION}:0:ih*${STATUS_BAR_FRACTION},` : '';
    const pad = i < tracks.length - 1 ? `,pad=iw+${GAP}:ih:0:0:color=0x${BG}` : '';
    chains.push(
      `[${i}:v]setpts=PTS-STARTPTS,fps=25,tpad=start_duration=${offset}:start_mode=clone:stop_mode=clone:stop_duration=${Math.ceil(end)},${crop}scale=${widths[i]}:${PANE_H},setsar=1,format=yuv420p${pad}[t${i}]`,
    );
  });
  const stack = tracks.length > 1 ? `${tracks.map((_, i) => `[t${i}]`).join('')}hstack=inputs=${tracks.length}[s]` : `[t0]null[s]`;
  const frameH = HEADER_H + PANE_H + FOOTER_H;
  const stage = join(run.dir, 'video', 'stage.mp4');
  const stageFilter = join(run.dir, 'video', 'stage-filter.txt');
  writeFileSync(stageFilter, [...chains, stack, `[s]pad=${width}:${frameH}:${MARGIN}:${HEADER_H}:color=0x${BG}[f]`].join(';\n'));
  await ffmpeg([...inputs, '-filter_complex_script', stageFilter, '-map', '[f]', '-t', end.toFixed(2), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', stage]);

  const parts = [`[0:v][1:v]overlay=0:0[o0]`];
  const overlayInputs = ['-i', stage, '-i', headerFile];
  capFiles.forEach((c, i) => {
    overlayInputs.push('-i', c.file);
    parts.push(`[o${i}][${2 + i}:v]overlay=0:${HEADER_H + PANE_H}:enable='between(t,${c.from.toFixed(2)},${c.to.toFixed(2)})'[o${i + 1}]`);
  });
  const filterFile = join(run.dir, 'video', 'filter.txt');
  writeFileSync(filterFile, parts.join(';\n'));
  const mp4 = join(run.dir, 'video', 'run.mp4');
  await ffmpeg([
    ...overlayInputs,
    '-filter_complex_script', filterFile,
    '-map', `[o${capFiles.length}]`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    mp4,
  ]);

  let gif: string | undefined;
  if (opts.gif) {
    gif = join(run.dir, 'video', 'run.gif');
    await ffmpeg([
      '-i', mp4,
      '-vf', 'fps=10,scale=1000:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
      gif,
    ]);
  }
  return { mp4, gif, seconds: Math.round(end) };
}
