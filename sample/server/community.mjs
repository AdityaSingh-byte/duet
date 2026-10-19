// The duet community sample: a few posts with comments, and profiles people can rename.
// The phone app (sample/community-app) reads the feed, comments and edits its profile; this
// page (/?post=1&as=maya) is the same post in Maya's browser, kept live by polling.
// COMMUNITY_BUG=1 plants a bug: each comment keeps the author's name from when it was written,
// so a rename never reaches comments already posted. The phone shows its own comments with its
// own profile name, so a test on the phone alone passes. Only another person's screen shows it.
//
//   node community.mjs                    -> http://localhost:8765
//   COMMUNITY_BUG=1 node community.mjs    -> the same, with the bug
//   adb reverse tcp:8765 tcp:8765         lets the phone reach it as localhost

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8765);
const BUG = process.env.COMMUNITY_BUG === '1';
const page = readFileSync(new URL('./community.html', import.meta.url));

const minutesAgo = (m) => Date.now() - m * 60_000;

const users = {
  alex: { id: 'alex', name: 'Alex' },
  maya: { id: 'maya', name: 'Maya Chen' },
  sam: { id: 'sam', name: 'Sam Okafor' },
  priya: { id: 'priya', name: 'Priya Nair' },
};

const posts = [
  {
    id: '1',
    userId: 'maya',
    title: 'Dark mode is here',
    body: 'Dark mode is now on for everyone. It follows your system setting, and you can switch it in Settings, Appearance. Tell us what looks off.',
    at: minutesAgo(140),
  },
  { id: '2', userId: 'sam', title: 'Office hours move to Thursday', body: 'From next week, office hours are Thursdays at 4 pm.', at: minutesAgo(300) },
  { id: '3', userId: 'priya', title: 'Share your desk setup', body: 'Post a photo of where you work. Best one gets a mug.', at: minutesAgo(1500) },
];

/** Each comment also keeps `authorName`, the name its author had when writing it. */
const comments = [
  { id: 'c1', postId: '1', userId: 'sam', authorName: 'Sam Okafor', text: 'Finally. Reading at night is so much easier now.', at: minutesAgo(120) },
  { id: 'c2', postId: '1', userId: 'priya', authorName: 'Priya Nair', text: 'Does it follow the system setting on Android too?', at: minutesAgo(70) },
  { id: 'c3', postId: '1', userId: 'maya', authorName: 'Maya Chen', text: 'It does, on Android and iOS.', at: minutesAgo(64) },
  { id: 'c4', postId: '2', userId: 'alex', authorName: 'Alex', text: 'Thursday works much better for me.', at: minutesAgo(250) },
];

// The fix: a comment shows its author's current name. The bug: the name it was written with.
const authorOf = (c) => (BUG ? c.authorName : users[c.userId]?.name ?? 'Someone');

const commentView = (c) => ({ id: c.id, userId: c.userId, author: authorOf(c), text: c.text, at: c.at });
const postView = (p) => ({
  id: p.id,
  userId: p.userId,
  author: users[p.userId].name,
  title: p.title,
  body: p.body,
  at: p.at,
  comments: comments.filter((c) => c.postId === p.id).length,
});

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function api(req, res, url) {
  const path = url.pathname;
  let m;
  if (req.method === 'GET' && path === '/api/posts') return sendJson(res, 200, posts.map(postView));
  if (req.method === 'GET' && (m = /^\/api\/posts\/(\w+)$/.exec(path))) {
    const p = posts.find((x) => x.id === m[1]);
    if (!p) return sendJson(res, 404, { error: 'That post is gone.' });
    return sendJson(res, 200, { ...postView(p), commentList: comments.filter((c) => c.postId === p.id).map(commentView) });
  }
  if (req.method === 'POST' && (m = /^\/api\/posts\/(\w+)\/comments$/.exec(path))) {
    const p = posts.find((x) => x.id === m[1]);
    const { user, text } = await readJson(req);
    const author = users[user];
    const clean = String(text ?? '').trim().slice(0, 500);
    if (!p || !author) return sendJson(res, 404, { error: 'Unknown post or person.' });
    if (!clean) return sendJson(res, 400, { error: 'Write something first.' });
    const c = { id: `c${comments.length + 1}`, postId: p.id, userId: author.id, authorName: author.name, text: clean, at: Date.now() };
    comments.push(c);
    console.log(`comment: ${author.name} on post ${p.id}: "${clean}"`);
    return sendJson(res, 200, commentView(c));
  }
  if ((m = /^\/api\/users\/(\w+)$/.exec(path))) {
    const u = users[m[1]];
    if (!u) return sendJson(res, 404, { error: 'Unknown person.' });
    if (req.method === 'GET') return sendJson(res, 200, u);
    if (req.method === 'PATCH') {
      const { name } = await readJson(req);
      const clean = String(name ?? '').trim().slice(0, 40);
      if (!clean) return sendJson(res, 400, { error: 'A name cannot be empty.' });
      console.log(`profile: ${u.name} is now ${clean}`);
      u.name = clean;
      return sendJson(res, 200, u);
    }
  }
  return sendJson(res, 404, { error: 'not found' });
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname.startsWith('/api/')) return void api(req, res, url);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return void res.end(page);
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`duet community sample on http://localhost:${PORT}${BUG ? ' (with the rename bug)' : ''}`));
