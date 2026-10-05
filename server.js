// Signaling Server + Web Client + หน้า Deep Link
// รัน: npm install && npm start   (ต้องใช้ Node.js 18+)
//
// HTTP
//   GET /                              -> หน้าแรกบนเว็บ: กรอก Room ID / สร้างห้องใหม่
//   GET /room/:roomId                  -> ห้องประชุมบนเว็บเบราว์เซอร์ (ไม่ต้องมีแอป)
//   GET /join/:roomId                  -> หน้าเชิญ: เลือกเข้าผ่านเว็บ หรือเปิดในแอป
//   GET /static/<file>                 -> ไฟล์ CSS/JS ของหน้าเว็บ
//   GET /health                        -> "Signaling server OK" (ใช้ทดสอบว่าเข้าถึงได้)
//   GET /.well-known/assetlinks.json   -> ไฟล์ยืนยันโดเมนสำหรับ Android App Links
//
// WebSocket (port เดียวกัน) — แอป Android และเว็บใช้ protocol เดียวกัน จึงอยู่ห้องเดียวกันได้
//   client -> server : {type:"join", room}
//   server -> client : {type:"joined", id, peers:[...]}
//   server -> others : {type:"peer-joined", id}
//   client -> server : {type:"offer"|"answer"|"candidate", to, ...}  -> ส่งต่อพร้อมเติม "from"
//   server -> others : {type:"peer-left", id}
//   server -> client : {type:"error", message}

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// ---------------- ตั้งค่า ----------------
const PORT = process.env.PORT || 8080;
const MAX_PEERS_PER_ROOM = 6; // Mesh ไม่ควรเกิน 4-6 คน
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/; // ต้องตรงกับฝั่งแอป

// ** แก้ให้ตรงกับแอปของคุณ ** (ใช้กับปุ่ม "เปิดในแอป" ในหน้าเชิญ)
const APP_SCHEME = process.env.APP_SCHEME || 'deeplinkwebrtc';
const APP_PACKAGE = process.env.APP_PACKAGE || 'com.example.deeplink_webrtc';

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_DIR = path.join(PUBLIC_DIR, 'static');
const STATIC_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ---------------- HTTP ----------------
function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// อ่านไฟล์ใหม่ทุกครั้ง: แก้ HTML แล้วรีเฟรชเบราว์เซอร์ได้เลย ไม่ต้องรีสตาร์ทเซิร์ฟเวอร์
function renderPage(res, file, roomId) {
  fs.readFile(path.join(PUBLIC_DIR, file), 'utf8', (err, html) => {
    if (err) return sendText(res, 500, 'Template not found: ' + file);
    // roomId ผ่าน ROOM_ID_RE แล้ว (a-z 0-9 - _ เท่านั้น) จึงแทนลง HTML ได้อย่างปลอดภัย
    const out = html
      .split('{{ROOM_ID}}').join(roomId || '')
      .split('{{APP_SCHEME}}').join(APP_SCHEME)
      .split('{{APP_PACKAGE}}').join(APP_PACKAGE);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(out);
  });
}

function serveStatic(res, name) {
  if (!/^[A-Za-z0-9_-]+\.(js|css|svg)$/.test(name)) return sendText(res, 404, 'Not found');
  fs.readFile(path.join(STATIC_DIR, name), (err, data) => {
    if (err) return sendText(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(name)],
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/') return renderPage(res, 'index.html', '');
  if (p === '/health') return sendText(res, 200, 'Signaling server OK');

  if (p === '/.well-known/assetlinks.json') {
    fs.readFile(path.join(PUBLIC_DIR, 'assetlinks.json'), (err, data) => {
      if (err) return sendText(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    });
    return;
  }

  let m = p.match(/^\/static\/([^/]+)$/);
  if (m) return serveStatic(res, m[1]);

  m = p.match(/^\/(join|room)\/([^/]+)\/?$/);
  if (m && ROOM_ID_RE.test(m[2])) {
    return renderPage(res, m[1] === 'join' ? 'join.html' : 'room.html', m[2]);
  }

  sendText(res, 404, 'Not found');
});

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = new Map(); // roomId -> Map<peerId, ws>

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, exceptId, msg) {
  for (const [id, peer] of room) {
    if (id !== exceptId) send(peer, msg);
  }
}

function leave(ws) {
  if (!ws.room) return;
  const roomId = ws.room;
  const room = rooms.get(roomId);
  ws.room = null;
  if (!room) return;
  room.delete(ws.id);
  broadcast(room, null, { type: 'peer-left', id: ws.id });
  if (room.size === 0) rooms.delete(roomId);
  console.log(`[${roomId}] ${ws.id} left (${room.size} remaining)`);
}

wss.on('connection', (ws, req) => {
  ws.id = crypto.randomUUID();
  ws.room = null;
  ws.isAlive = true;
  ws.client = /Mozilla/.test(req.headers['user-agent'] || '') ? 'web' : 'app';
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join': {
        const roomId = String(msg.room || '').trim();
        if (!ROOM_ID_RE.test(roomId) || ws.room) return;
        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        const room = rooms.get(roomId);
        if (room.size >= MAX_PEERS_PER_ROOM) {
          send(ws, { type: 'error', message: 'ห้องเต็มแล้ว' });
          return;
        }
        const existingPeers = [...room.keys()];
        room.set(ws.id, ws);
        ws.room = roomId;
        send(ws, { type: 'joined', id: ws.id, peers: existingPeers });
        broadcast(room, ws.id, { type: 'peer-joined', id: ws.id });
        console.log(`[${roomId}] ${ws.id} joined via ${ws.client} (${room.size} total)`);
        break;
      }
      case 'offer':
      case 'answer':
      case 'candidate': {
        const room = rooms.get(ws.room);
        if (!room) return;
        const target = room.get(msg.to);
        if (!target) return;
        msg.from = ws.id;
        delete msg.to;
        send(target, msg);
        break;
      }
      case 'leave':
        leave(ws);
        break;
    }
  });

  ws.on('close', () => leave(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`  Web       : http://localhost:${PORT}`);
  console.log(`  WebSocket : ws://<IP-ของเครื่องนี้>:${PORT}`);
  console.log(`  Invite    : http://<IP-ของเครื่องนี้>:${PORT}/join/<roomId>`);
});
