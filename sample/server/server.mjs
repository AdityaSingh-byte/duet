// The duet sample relay. One host per room shares a browser tab; the host page sends it as
// JPEG frames, and this server passes the latest frame to every viewer. Not WebRTC: just
// enough of a live session to show two actors (a browser and a phone) in one test.
//
//   node server.mjs            -> http://localhost:8080 (host page), ws://localhost:8080/ws
//   adb reverse tcp:8080 tcp:8080   lets the phone reach it as localhost

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);
const hostPage = readFileSync(new URL('./host.html', import.meta.url));

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

http.listen(PORT, () => console.log(`duet sample server on http://localhost:${PORT}`));
