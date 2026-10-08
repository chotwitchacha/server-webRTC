// ที่เก็บข้อมูลห้อง (ผู้สร้างห้อง) และไฟล์บันทึก
//
// โหมด supabase : ตั้ง SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY แล้ว -> ข้อมูลอยู่ถาวรบน Supabase (ฟรี)
// โหมด local    : ไม่ได้ตั้งค่า -> เก็บในหน่วยความจำ + โฟลเดอร์ local-data/ (ใช้ทดสอบบนคอมเท่านั้น
//                 บน Render ข้อมูลจะหายทุกครั้งที่เซิร์ฟเวอร์รีสตาร์ท)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'recordings';
const LOCAL_DIR = path.join(__dirname, 'local-data');

let sb = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
const mode = sb ? 'supabase' : 'local';

// ใช้ในโหมด local เท่านั้น
const mem = { rooms: new Map(), recordings: new Map() };

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function check(result) {
  if (result.error) throw result.error;
  return result.data;
}

// ---------------- ผู้สร้างห้อง ----------------
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function tokenMatches(token, hash) {
  if (typeof token !== 'string' || !token || !hash) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function getRoomHash(roomId) {
  if (mode === 'local') return mem.rooms.get(roomId) || null;
  const row = check(await sb.from('rooms').select('host_token_hash').eq('room_id', roomId).maybeSingle());
  return row ? row.host_token_hash : null;
}

/**
 * คนแรกที่เข้าห้องที่ยังไม่เคยมี = ผู้สร้างห้อง ได้รหัสลับ (token) กลับไปเก็บไว้
 * คนต่อๆ ไปเป็นผู้สร้างห้องได้เฉพาะเมื่อส่งรหัสที่ถูกต้องมา
 * @returns {{isHost: boolean, newToken: string|null}}
 */
async function claimOrVerifyHost(roomId, token) {
  const existing = await getRoomHash(roomId);
  if (existing) return { isHost: tokenMatches(token, existing), newToken: null };

  const newToken = crypto.randomBytes(24).toString('base64url');
  const hash = hashToken(newToken);

  if (mode === 'local') {
    mem.rooms.set(roomId, hash);
    return { isHost: true, newToken };
  }

  const { error } = await sb.from('rooms').insert({ room_id: roomId, host_token_hash: hash });
  if (error) {
    if (error.code === '23505') { // มีคนสร้างห้องนี้พร้อมกันพอดี
      return { isHost: tokenMatches(token, await getRoomHash(roomId)), newToken: null };
    }
    throw error;
  }
  return { isHost: true, newToken };
}

async function roomExists(roomId) {
  return !!(await getRoomHash(roomId));
}

async function verifyHost(roomId, token) {
  return tokenMatches(token, await getRoomHash(roomId));
}

// ---------------- ไฟล์บันทึก ----------------
function partDir(rec) {
  return `${rec.room_id}/${rec.id}`;
}

function partName(seq) {
  return String(seq).padStart(6, '0');
}

async function createRecording(roomId, mimeType) {
  if (mode === 'local') {
    const row = {
      id: crypto.randomUUID(), room_id: roomId, status: 'recording', mime_type: mimeType,
      parts: 0, size_bytes: 0, started_at: new Date().toISOString(), ended_at: null, duration_seconds: null,
    };
    mem.recordings.set(row.id, row);
    return row;
  }
  return check(await sb.from('recordings').insert({ room_id: roomId, mime_type: mimeType }).select('*').single());
}

async function getRecording(id) {
  if (mode === 'local') return mem.recordings.get(id) || null;
  return check(await sb.from('recordings').select('*').eq('id', id).maybeSingle());
}

async function savePart(rec, seq, buffer) {
  const name = partName(seq);
  const parts = Math.max(rec.parts, seq + 1);
  const size = Number(rec.size_bytes) + buffer.length;

  if (mode === 'local') {
    const dir = path.join(LOCAL_DIR, rec.room_id, rec.id);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, name), buffer);
    rec.parts = parts;
    rec.size_bytes = size;
    return;
  }

  check(await sb.storage.from(BUCKET).upload(`${partDir(rec)}/${name}`, buffer, {
    contentType: 'application/octet-stream',
    upsert: true,
  }));
  check(await sb.from('recordings').update({ parts, size_bytes: size }).eq('id', rec.id).select('id'));
}

async function finishRecording(id, status) {
  const rec = await getRecording(id);
  if (!rec || rec.status !== 'recording') return rec;
  const endedAt = new Date();
  const duration = Math.max(0, Math.round((endedAt - new Date(rec.started_at)) / 1000));
  const changes = { status, ended_at: endedAt.toISOString(), duration_seconds: duration };

  if (mode === 'local') return Object.assign(rec, changes);
  return check(await sb.from('recordings').update(changes).eq('id', id).select('*').single());
}

async function listRecordings(roomId) {
  if (mode === 'local') {
    return [...mem.recordings.values()]
      .filter((r) => r.room_id === roomId)
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
  }
  return check(await sb.from('recordings')
    .select('id, status, mime_type, parts, size_bytes, started_at, ended_at, duration_seconds')
    .eq('room_id', roomId)
    .order('started_at', { ascending: false })
    .limit(100));
}

/** รายชื่อชิ้นส่วนไฟล์ เรียงตามลำดับ */
async function listParts(rec) {
  if (mode === 'local') {
    const dir = path.join(LOCAL_DIR, rec.room_id, rec.id);
    try {
      return (await fs.promises.readdir(dir)).filter((n) => /^\d{6}$/.test(n)).sort();
    } catch (e) {
      return [];
    }
  }
  const names = [];
  for (let offset = 0; ; offset += 1000) {
    const page = check(await sb.storage.from(BUCKET).list(partDir(rec), {
      limit: 1000, offset, sortBy: { column: 'name', order: 'asc' },
    }));
    names.push(...page.map((o) => o.name));
    if (page.length < 1000) break;
  }
  return names.filter((n) => /^\d{6}$/.test(n)).sort();
}

async function readPart(rec, name) {
  if (mode === 'local') {
    return fs.promises.readFile(path.join(LOCAL_DIR, rec.room_id, rec.id, name));
  }
  const blob = check(await sb.storage.from(BUCKET).download(`${partDir(rec)}/${name}`));
  return Buffer.from(await blob.arrayBuffer());
}

async function deleteRecording(rec) {
  if (mode === 'local') {
    await fs.promises.rm(path.join(LOCAL_DIR, rec.room_id, rec.id), { recursive: true, force: true });
    mem.recordings.delete(rec.id);
    return;
  }
  const names = await listParts(rec);
  for (let i = 0; i < names.length; i += 100) {
    const paths = names.slice(i, i + 100).map((n) => `${partDir(rec)}/${n}`);
    check(await sb.storage.from(BUCKET).remove(paths));
  }
  check(await sb.from('recordings').delete().eq('id', rec.id).select('id'));
}

/** เซิร์ฟเวอร์เพิ่งเริ่มทำงาน: การบันทึกที่ค้างจากรอบก่อนถือว่าไม่ครบ */
async function markStaleRecordings() {
  if (mode === 'local') return;
  check(await sb.from('recordings')
    .update({ status: 'interrupted', ended_at: new Date().toISOString() })
    .eq('status', 'recording')
    .select('id'));
}

module.exports = {
  mode, httpError,
  claimOrVerifyHost, verifyHost, roomExists,
  createRecording, getRecording, savePart, finishRecording,
  listRecordings, listParts, readPart, deleteRecording, markStaleRecordings,
};
