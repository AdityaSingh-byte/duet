#!/usr/bin/env node
// Builds the README/site demo from two recorded runs of examples/fullscreen-on-a-phone.yaml:
// the build with the bug (fails) and the fixed build (passes), with title cards between them.
//
//   duet scenario run examples/fullscreen-on-a-phone.yaml --record --pace 900 --runs-dir .duet/takes/bug     # demo/rotation-bug build
//   duet scenario run examples/fullscreen-on-a-phone.yaml --record --pace 900 --runs-dir .duet/takes/fixed   # main build
//   node scripts/make-demo-video.mjs .duet/takes/bug/<run> .duet/takes/fixed/<run>
//
// Writes docs/media/demo.mp4 (the whole story) and docs/media/demo.gif (the part that matters).
// Needs ffmpeg and Google Chrome.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const [bugDir, fixedDir] = process.argv.slice(2).map((d) => resolve(d));
if (!bugDir || !fixedDir) {
  console.error('usage: node scripts/make-demo-video.mjs <bug run dir> <fixed run dir>');
  process.exit(2);
}
const out = resolve('docs/media');
const work = resolve('.duet/demo-build');
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function size(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return r.stdout.trim().split(',').map(Number);
}

/** Seconds into a run's video when the step starting with `prefix` began. */
function stepTime(runDir, prefix) {
  const tracks = JSON.parse(readFileSync(join(runDir, 'video', 'tracks.json'), 'utf8'));
  const t0 = Math.min(...tracks.map((t) => t.startedAt));
  for (const line of readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line);
    if (e.actor === 'scenario' && e.action === 'step' && e.args.source.startsWith(prefix)) return (new Date(e.t).getTime() - t0) / 1000;
  }
  throw new Error(`no step starting with "${prefix}" in ${runDir}`);
}

const bugMp4 = join(bugDir, 'video', 'run.mp4');
const fixedMp4 = join(fixedDir, 'video', 'run.mp4');
const [W, H] = size(bugMp4);

// Title cards, drawn by Chrome so they match the captions.
const cards = {
  intro: ['duet', 'A host presents from Chrome. A viewer watches on a real Android phone and taps Full screen.', 'Both driven by an AI agent, step by step.'],
  bug: ['Take 1: the build with the bug', 'Full screen opens, the layout switches to two panes, the stage remounts, and full screen closes itself.', ''],
  fix: ['Take 2: the fix', 'Keep the full-screen state in the room, which survives the layout switch. Rebuild, reinstall, run the same steps.', ''],
};
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
for (const [name, [title, line1, line2]] of Object.entries(cards)) {
  await page.setContent(`<style>
    body { margin: 0; width: ${W}px; height: ${H}px; background: #161616; color: #f2f2f2; display: flex; flex-direction: column; justify-content: center; padding: 0 140px; box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    h1 { font-size: 64px; font-weight: 650; margin: 0 0 28px; }
    p { font-size: 32px; line-height: 1.45; color: #cfcfcf; margin: 0 0 12px; max-width: 1300px; }
  </style><h1>${title}</h1><p>${line1}</p>${line2 ? `<p>${line2}</p>` : ''}`);
  await page.screenshot({ path: join(work, `${name}.png`) });
}
await browser.close();

function card(name, seconds) {
  const file = join(work, `${name}.mp4`);
  ffmpeg(['-loop', '1', '-t', String(seconds), '-i', join(work, `${name}.png`), '-vf', 'fps=25,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', file]);
  return file;
}

function normalized(src, name, from, to) {
  const file = join(work, `${name}.mp4`);
  const trim = [...(from !== undefined ? ['-ss', from.toFixed(2)] : []), ...(to !== undefined ? ['-to', to.toFixed(2)] : [])];
  ffmpeg([...trim, '-i', src, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x161616,fps=25,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', file]);
  return file;
}

function concat(files, dest) {
  const list = join(work, `${dest.split('/').pop()}.txt`);
  writeFileSync(list, files.map((f) => `file '${f}'`).join('\n'));
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest]);
}

// The whole story.
concat(
  [card('intro', 4), card('bug', 4), normalized(bugMp4, 'bug-full'), card('fix', 4), normalized(fixedMp4, 'fixed-full')],
  join(out, 'demo.mp4'),
);

// The part that matters, for the README: from "Full screen should turn the phone sideways" to the end of each take.
const bugFrom = stepTime(bugDir, 'note: Full screen') - 0.5;
const fixedFrom = stepTime(fixedDir, 'note: Full screen') - 0.5;
const fixedTo = stepTime(fixedDir, 'note: Back returns') + 3;
concat(
  [card('bug', 3), normalized(bugMp4, 'bug-cut', bugFrom), card('fix', 3), normalized(fixedMp4, 'fixed-cut', fixedFrom, fixedTo)],
  join(work, 'highlights.mp4'),
);
ffmpeg([
  '-i', join(work, 'highlights.mp4'),
  '-vf', 'fps=10,scale=960:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  join(out, 'demo.gif'),
]);
console.log(`wrote ${join(out, 'demo.mp4')} and ${join(out, 'demo.gif')}`);
