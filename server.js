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
const db = require('./db');

// ---------------- ตั้งค่า ----------------
const PORT = process.env.PORT || 8080;
const MAX_PEERS_PER_ROOM = 6;
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME_RE = /^video\/(webm|mp4)(;[a-z0-9=.,\s-]*)?$/i;
const MAX_PART_BYTES = 20 * 1024 * 1024;
const TICKET_TTL_MS = 60 * 1000;

// ** แก้ให้ตรงกับแอปของคุณ ** (ใช้กับปุ่ม "เปิดในแอป" ในหน้าเชิญ)
const APP_SCHEME = process.env.APP_SCHEME || 'deeplinkwebrtc';
const APP_PACKAGE = process.env.APP_PACKAGE || 'com.example.deeplink_webrtc';

// รหัสสำหรับสร้างห้อง: ต้องตรงกับ Config.CREATE_ROOM_KEY ในแอป Android
// ตั้งค่าจริงผ่าน Environment ของ Render (อย่าใช้ค่าเริ่มต้นนี้ตอนใช้งานจริง)
const CREATE_ROOM_KEY = process.env.CREATE_ROOM_KEY || 'dev-create-key';

function createKeyMatches(key) {
  if (typeof key !== 'string') return false;
  const a = Buffer.from(key);
  const b = Buffer.from(CREATE_ROOM_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_DIR = path.join(PUBLIC_DIR, 'static');
const STATIC_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const rooms = new Map();            // roomId -> Map<peerId, ws>
const activeRecordings = new Map(); // roomId -> { recId, peerId }
const downloadTickets = new Map();  // ticket -> { recId, expires }

// ---------------- HTTP helpers ----------------
function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(db.httpError(413, 'ไฟล์ใหญ่เกินไป'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = (await readBody(req, 8 * 1024)).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { throw db.httpError(400, 'ข้อมูลไม่ถูกต้อง'); }
}

function renderPage(res, file, roomId) {
  fs.readFile(path.join(PUBLIC_DIR, file), 'utf8', (err, html) => {
    if (err) return sendText(res, 500, 'Template not found: ' + file);
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
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(name)], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------------- สิทธิ์ผู้สร้างห้อง ----------------
function bearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

async function requireHost(req, roomId) {
  if (!(await db.verifyHost(roomId, bearerToken(req)))) {
    throw db.httpError(403, 'เฉพาะผู้สร้างห้องเท่านั้นที่ทำรายการนี้ได้');
  }
}

async function loadRecording(id) {
  if (!UUID_RE.test(id)) throw db.httpError(404, 'ไม่พบไฟล์บันทึก');
  const rec = await db.getRecording(id);
  if (!rec) throw db.httpError(404, 'ไม่พบไฟล์บันทึก');
  return rec;
}

function setRecordingActive(roomId, value) {
  if (value) activeRecordings.set(roomId, value);
  else activeRecordings.delete(roomId);
  const room = rooms.get(roomId);
  if (room) broadcast(room, null, { type: 'recording', active: !!value });
}

function clearActiveIfMatches(roomId, recId) {
  const active = activeRecordings.get(roomId);
  if (active && active.recId === recId) setRecordingActive(roomId, null);
}

// ---------------- Recording API ----------------
const ROOM_ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function generateRoomId() {
  let id = '';
  for (let i = 0; i < 9; i++) {
    if (i > 0 && i % 3 === 0) id += '-';
    id += ROOM_ID_CHARS[crypto.randomInt(ROOM_ID_CHARS.length)];
  }
  return id;
}

function publicBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return proto + '://' + req.headers.host;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  let m;

  // POST /api/rooms  body: {createKey}  -> สร้างห้อง + ลิงก์เชิญ (เฉพาะแอป Android)
  // ห้องถูกสร้างทันที คนที่ได้รับลิงก์จึงเข้าห้องได้เลย แม้ผู้สร้างยังไม่ได้กดเริ่มประชุม
  if (p === '/api/rooms' && req.method === 'POST') {
    const body = await readJson(req);
    if (!createKeyMatches(body.createKey)) throw db.httpError(403, 'ไม่มีสิทธิ์สร้างห้อง');
    for (let attempt = 0; attempt < 5; attempt++) {
      const roomId = generateRoomId();
      if (await db.roomExists(roomId)) continue;
      const auth = await db.claimOrVerifyHost(roomId, null);
      if (!auth.newToken) continue; // ชนกับห้องที่เพิ่งถูกสร้างพร้อมกัน
      console.log(`[${roomId}] room created via API`);
      return sendJson(res, 201, {
        roomId,
        hostToken: auth.newToken,
        link: publicBaseUrl(req) + '/join/' + roomId,
      });
    }
    throw db.httpError(500, 'สร้างห้องไม่สำเร็จ กรุณาลองใหม่');
  }

  // /api/rooms/:roomId/status  -> ห้องนี้ถูกสร้างไว้แล้วหรือยัง (หน้าเว็บใช้เช็กก่อนเปิดกล้อง)
  if ((m = p.match(/^\/api\/rooms\/([^/]+)\/status$/)) && req.method === 'GET') {
    const roomId = m[1];
    if (!ROOM_ID_RE.test(roomId)) return sendJson(res, 200, { exists: false });
    const room = rooms.get(roomId);
    return sendJson(res, 200, {
      exists: await db.roomExists(roomId),
      participants: room ? room.size : 0,
    });
  }

  // /api/rooms/:roomId/recordings
  if ((m = p.match(/^\/api\/rooms\/([^/]+)\/recordings$/))) {
    const roomId = m[1];
    if (!ROOM_ID_RE.test(roomId)) throw db.httpError(404, 'ไม่พบห้อง');
    await requireHost(req, roomId);

    if (req.method === 'GET') {
      return sendJson(res, 200, { recordings: await db.listRecordings(roomId) });
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const room = rooms.get(roomId);
      if (!room || !room.has(body.peerId)) throw db.httpError(409, 'ต้องอยู่ในห้องก่อนจึงจะเริ่มบันทึกได้');
      if (activeRecordings.has(roomId)) throw db.httpError(409, 'ห้องนี้กำลังบันทึกอยู่แล้ว');
      if (typeof body.mimeType !== 'string' || !MIME_RE.test(body.mimeType)) {
        throw db.httpError(400, 'รูปแบบไฟล์ไม่รองรับ');
      }
      const rec = await db.createRecording(roomId, body.mimeType);
      setRecordingActive(roomId, { recId: rec.id, peerId: body.peerId });
      console.log(`[${roomId}] recording started ${rec.id}`);
      return sendJson(res, 201, { id: rec.id });
    }
    throw db.httpError(405, 'Method not allowed');
  }

  // /api/recordings/:id/parts?seq=N
  if ((m = p.match(/^\/api\/recordings\/([^/]+)\/parts$/)) && req.method === 'POST') {
    const rec = await loadRecording(m[1]);
    await requireHost(req, rec.room_id);
    if (rec.status !== 'recording') throw db.httpError(409, 'การบันทึกนี้จบไปแล้ว');
    const seq = Number(url.searchParams.get('seq'));
    if (!Number.isInteger(seq) || seq < 0 || seq > 999999) throw db.httpError(400, 'seq ไม่ถูกต้อง');
    const buffer = await readBody(req, MAX_PART_BYTES);
    if (buffer.length === 0) throw db.httpError(400, 'ไม่มีข้อมูล');
    await db.savePart(rec, seq, buffer);
    return sendJson(res, 200, { ok: true });
  }

  // /api/recordings/:id/stop
  if ((m = p.match(/^\/api\/recordings\/([^/]+)\/stop$/)) && req.method === 'POST') {
    const rec = await loadRecording(m[1]);
    await requireHost(req, rec.room_id);
    const done = await db.finishRecording(rec.id, 'ready');
    clearActiveIfMatches(rec.room_id, rec.id);
    console.log(`[${rec.room_id}] recording stopped ${rec.id}`);
    return sendJson(res, 200, { recording: done });
  }

  // /api/recordings/:id/ticket
  if ((m = p.match(/^\/api\/recordings\/([^/]+)\/ticket$/)) && req.method === 'POST') {
    const rec = await loadRecording(m[1]);
    await requireHost(req, rec.room_id);
    const ticket = crypto.randomBytes(24).toString('base64url');
    downloadTickets.set(ticket, { recId: rec.id, expires: Date.now() + TICKET_TTL_MS });
    return sendJson(res, 200, { url: `/api/recordings/${rec.id}/file?ticket=${ticket}` });
  }

  // /api/recordings/:id/file?ticket=
  if ((m = p.match(/^\/api\/recordings\/([^/]+)\/file$/)) && req.method === 'GET') {
    const ticket = downloadTickets.get(url.searchParams.get('ticket') || '');
    if (!ticket || ticket.recId !== m[1] || ticket.expires < Date.now()) {
      throw db.httpError(403, 'ลิงก์ดาวน์โหลดหมดอายุ กดดาวน์โหลดใหม่อีกครั้ง');
    }
    return streamRecording(req, res, await loadRecording(m[1]));
  }

  // DELETE /api/recordings/:id
  if ((m = p.match(/^\/api\/recordings\/([^/]+)$/)) && req.method === 'DELETE') {
    const rec = await loadRecording(m[1]);
    await requireHost(req, rec.room_id);
    if (rec.status === 'recording') throw db.httpError(409, 'หยุดบันทึกก่อนจึงจะลบได้');
    await db.deleteRecording(rec);
    return sendJson(res, 200, { ok: true });
  }

  throw db.httpError(404, 'Not found');
}

/** รวมชิ้นส่วนทั้งหมดตามลำดับเป็นไฟล์เดียว แล้วส่งให้ดาวน์โหลด */
async function streamRecording(req, res, rec) {
  const names = await db.listParts(rec);
  if (names.length === 0) throw db.httpError(404, 'ไฟล์บันทึกนี้ไม่มีข้อมูล');

  const ext = rec.mime_type.startsWith('video/mp4') ? 'mp4' : 'webm';
  const stamp = new Date(rec.started_at).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.writeHead(200, {
    'Content-Type': rec.mime_type.split(';')[0],
    'Content-Disposition': `attachment; filename="meeting-${rec.room_id}-${stamp}.${ext}"`,
    'Cache-Control': 'no-store',
  });

  let aborted = false;
  req.on('close', () => { aborted = true; });
  for (const name of names) {
    if (aborted) return;
    const buf = await db.readPart(rec, name);
    if (!res.write(buf)) await new Promise((resolve) => res.once('drain', resolve));
  }
  res.end();
}

// ---------------- HTTP router ----------------
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p.startsWith('/api/')) return handleApi(req, res, url);
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

  m = p.match(/^\/(join|room|recordings)\/([^/]+)\/?$/);
  if (m && ROOM_ID_RE.test(m[2])) return renderPage(res, m[1] + '.html', m[2]);

  sendText(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) {
      sendJson(res, status, { error: status === 500 ? 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' : err.message });
    } else {
      res.destroy();
    }
  });
});

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, exceptId, msg) {
  for (const [id, peer] of room) {
    if (id !== exceptId) send(peer, msg);
  }
}

async function handleJoin(ws, msg) {
  const roomId = String(msg.room || '').trim();
  if (!ROOM_ID_RE.test(roomId) || ws.room || ws.joining) return;
  const token = typeof msg.hostToken === 'string' ? msg.hostToken.slice(0, 200) : null;

  ws.joining = true;
  let auth;
  try {
    // สร้างห้องใหม่ได้เฉพาะแอป Android ที่ส่ง createKey ถูกต้อง
    // คนที่ได้รับลิงก์ (เว็บ) เข้าได้เฉพาะห้องที่มีอยู่แล้ว
    const canCreate = msg.create === true && createKeyMatches(msg.createKey);
    if (!canCreate && !(await db.roomExists(roomId))) {
      if (ws.readyState === WebSocket.OPEN) {
        send(ws, {
          type: 'error',
          code: 'room-not-found',
          message: 'ไม่พบห้องประชุมนี้ ตรวจสอบลิงก์อีกครั้ง หรือขอลิงก์ใหม่จากผู้สร้างห้อง',
        });
      }
      return;
    }
    auth = await db.claimOrVerifyHost(roomId, token);
  } finally {
    ws.joining = false;
  }
  if (ws.readyState !== WebSocket.OPEN) return;

  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  const room = rooms.get(roomId);
  if (room.size >= MAX_PEERS_PER_ROOM) {
    send(ws, { type: 'error', code: 'room-full', message: 'ห้องเต็มแล้ว' });
    return;
  }

  const existingPeers = [...room.keys()];
  room.set(ws.id, ws);
  ws.room = roomId;
  ws.isHost = auth.isHost;

  const reply = {
    type: 'joined',
    id: ws.id,
    peers: existingPeers,
    isHost: auth.isHost,
    recording: activeRecordings.has(roomId),
    recordingAvailable: true,
  };
  if (auth.newToken) reply.hostToken = auth.newToken; // ส่งให้ผู้สร้างห้องครั้งเดียว ให้เก็บไว้เอง
  send(ws, reply);
  broadcast(room, ws.id, { type: 'peer-joined', id: ws.id });
  console.log(`[${roomId}] ${ws.id} joined via ${ws.client}${auth.isHost ? ' (host)' : ''} (${room.size} total)`);
}

function leave(ws) {
  if (!ws.room) return;
  const roomId = ws.room;
  const room = rooms.get(roomId);
  ws.room = null;

  // ผู้บันทึกหลุดออกไปกลางคัน -> ปิดการบันทึก (เก็บส่วนที่อัปโหลดแล้วไว้)
  const active = activeRecordings.get(roomId);
  if (active && active.peerId === ws.id) {
    db.finishRecording(active.recId, 'interrupted').catch((err) => console.error(err));
    setRecordingActive(roomId, null);
  }

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
      case 'join':
        handleJoin(ws, msg).catch((err) => {
          console.error('join failed', err);
          send(ws, { type: 'error', message: 'เข้าห้องไม่ได้ กรุณาลองใหม่' });
        });
        break;
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

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [ticket, t] of downloadTickets) {
    if (t.expires < now) downloadTickets.delete(ticket);
  }
}, 30000);

db.markStaleRecordings().catch((err) => console.error('markStaleRecordings', err));

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`  Storage   : ${db.mode === 'supabase'
    ? 'Supabase'
    : 'local (ทดสอบเท่านั้น ข้อมูลหายเมื่อรีสตาร์ท — ตั้ง SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY เพื่อใช้ Supabase)'}`);
  console.log(`  Web       : http://localhost:${PORT}`);
});
