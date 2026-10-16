// The duet sample server, for two demos:
//
// 1. A room: one host shares a browser tab; the host page sends it as JPEG frames, and this
//    server passes the latest frame to every viewer (the duet sample app). Not WebRTC, just
//    enough of a live session to show two actors in one test.
// 2. Sign in with your phone: a browser shows a 6-digit code (/pair); the duet pair app enters
//    it and approves; that browser is signed in. PAIR_BUG=1 plants a bug in the approval.
//
//   node server.mjs                 -> http://localhost:8080 (room host), /pair (sign-in page)
//   PAIR_BUG=1 node server.mjs      -> the same, with the pairing bug
//   adb reverse tcp:8080 tcp:8080   lets the phone reach it as localhost

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);
const hostPage = readFileSync(new URL('./host.html', import.meta.url));
const pairPage = readFileSync(new URL('./pair.html', import.meta.url));
const PAIR_BUG = process.env.PAIR_BUG === '1';

/** Browsers waiting to be signed in, in the order they asked: { id, code, status, name, at } */
const pairings = [];
const PAIR_TTL_MS = 5 * 60_000;

function newCode() {
  for (;;) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!pairings.some((p) => p.code === code && p.status === 'waiting')) return code;
  }
}

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
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function pairApi(req, res) {
  const now = Date.now();
  for (const p of pairings) if (p.status === 'waiting' && now - p.at > PAIR_TTL_MS) p.status = 'expired';

  if (req.method === 'POST' && req.url === '/api/pair') {
    const p = { id: Math.random().toString(36).slice(2, 10), code: newCode(), status: 'waiting', name: null, at: now };
    pairings.push(p);
    console.log(`pair: browser ${p.id} waiting with code ${p.code}`);
    return sendJson(res, 200, { id: p.id, code: p.code });
  }
  const m = /^\/api\/pair\/([a-z0-9]+)$/.exec(req.url ?? '');
  if (req.method === 'GET' && m) {
    const p = pairings.find((x) => x.id === m[1]);
    return p ? sendJson(res, 200, { status: p.status, name: p.name }) : sendJson(res, 404, { error: 'unknown' });
  }
  if (req.method === 'POST' && req.url === '/api/pair/approve') {
    const { code, name } = await readJson(req);
    const waiting = pairings.filter((p) => p.status === 'waiting');
    const match = waiting.find((p) => p.code === String(code));
    if (!match) return sendJson(res, 404, { error: 'That code is not waiting. Check the code on the computer.' });
    // The planted bug: the code is checked, then the newest waiting browser is approved. With one
    // browser waiting that is the same browser, so a test with one browser passes.
    const target = PAIR_BUG ? waiting[waiting.length - 1] : match;
    target.status = 'approved';
    target.name = String(name || 'Phone owner').slice(0, 40);
    console.log(`pair: code ${code} approved, signed in browser ${target.id}${target === match ? '' : ' (the wrong one)'}`);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'not found' });
}

/** room name -> { clients: Set<{ws, name, role}>, frame: string | null } */
const rooms = new Map();

function roomFor(name) {
  if (!rooms.has(name)) rooms.set(name, { clients: new Set(), frame: null });
  return rooms.get(name);
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastPeople(room) {
  const people = [...room.clients].map((c) => ({ name: c.name, role: c.role }));
  for (const c of room.clients) send(c.ws, { type: 'people', people });
}

const http = createServer((req, res) => {
  if (req.url?.startsWith('/api/pair')) return void pairApi(req, res);
  if (req.url === '/pair' || req.url?.startsWith('/pair?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return void res.end(pairPage);
  }
  if (req.url === '/' || req.url?.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(hostPage);
  } else if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: [...rooms].map(([name, r]) => ({ name, people: r.clients.size, sharing: !!r.frame })) }));
  } else {
    res.writeHead(404).end();
  }
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 4 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const room = roomFor(q.get('room') || 'demo');
  const client = { ws, name: q.get('name') || 'Someone', role: q.get('role') === 'host' ? 'host' : 'viewer' };
  room.clients.add(client);
  console.log(`${client.role} "${client.name}" joined ${q.get('room') || 'demo'} (${room.clients.size} here)`);
  broadcastPeople(room);
  if (client.role === 'viewer' && room.frame) send(ws, { type: 'frame', data: room.frame });

  ws.on('message', (raw) => {
    if (client.role !== 'host') return;
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'frame' && typeof msg.data === 'string' && msg.data.startsWith('data:image/jpeg;base64,')) {
      room.frame = msg.data;
      for (const c of room.clients) if (c.role === 'viewer') send(c.ws, { type: 'frame', data: msg.data });
    } else if (msg.type === 'stopped') {
      room.frame = null;
      for (const c of room.clients) if (c.role === 'viewer') send(c.ws, { type: 'stopped' });
    }
  });

  ws.on('close', () => {
    room.clients.delete(client);
    if (client.role === 'host' && ![...room.clients].some((c) => c.role === 'host')) {
      room.frame = null;
      for (const c of room.clients) send(c.ws, { type: 'stopped' });
    }
    broadcastPeople(room);
  });
});

http.listen(PORT, () => console.log(`duet sample server on http://localhost:${PORT}${PAIR_BUG ? ' (with the pairing bug)' : ''}`));
