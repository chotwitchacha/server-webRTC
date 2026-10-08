// หน้ารายการไฟล์บันทึก — ใช้รหัสผู้สร้างห้องที่เก็บไว้ในเบราว์เซอร์นี้
(function () {
  'use strict';

  const roomId = decodeURIComponent(location.pathname.split('/')[2] || '');
  const key = 'meeting:host:' + roomId;
  const $ = (id) => document.getElementById(id);
  const message = $('message');
  const list = $('list');

  document.querySelectorAll('[data-room]').forEach((el) => { el.textContent = roomId; });
  $('backLink').href = '/room/' + encodeURIComponent(roomId);

  // รับรหัสจากแอป Android (#host=...)
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('host');
  if (fromLink) {
    try { localStorage.setItem(key, fromLink); } catch (e) { /* private mode */ }
    history.replaceState(null, '', location.pathname);
  }
  let token = fromLink;
  try { token = token || localStorage.getItem(key); } catch (e) { /* ใช้ไม่ได้ */ }

  if (!token) {
    message.textContent = 'หน้านี้เปิดได้เฉพาะผู้สร้างห้อง บนเบราว์เซอร์หรือแอปที่ใช้สร้างห้องนี้';
    return;
  }
  load();

  async function api(method, url) {
    const res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + token } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  async function load() {
    try {
      const { recordings } = await api('GET', '/api/rooms/' + encodeURIComponent(roomId) + '/recordings');
      render(recordings);
    } catch (err) {
      message.textContent = err.message;
      list.hidden = true;
    }
  }

  function render(items) {
    if (items.length === 0) {
      message.textContent = 'ห้องนี้ยังไม่มีไฟล์บันทึก เริ่มบันทึกได้จากปุ่ม "บันทึก" ในห้องประชุม';
      list.hidden = true;
      return;
    }
    message.textContent = 'ไฟล์ทั้งหมด ' + items.length + ' รายการ';
    list.replaceChildren(...items.map(renderItem));
    list.hidden = false;
  }

  const STATUS = {
    recording: 'กำลังบันทึก',
    ready: 'พร้อมดาวน์โหลด',
    interrupted: 'บันทึกไม่ครบ เพราะการเชื่อมต่อหลุด',
  };

  function renderItem(rec) {
    const li = document.createElement('li');
    li.className = 'rec-item';

    const when = document.createElement('p');
    when.className = 'when';
    when.textContent = new Date(rec.started_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

    const meta = document.createElement('p');
    meta.className = 'meta' + (rec.status === 'interrupted' ? ' warn' : '');
    meta.textContent = [formatDuration(rec.duration_seconds), formatSize(rec.size_bytes), STATUS[rec.status] || rec.status]
      .filter(Boolean).join(', ');

    const actions = document.createElement('div');
    actions.className = 'actions';
    const busy = rec.status === 'recording';

    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'btn btn-primary';
    download.textContent = 'ดาวน์โหลด';
    download.disabled = busy || rec.parts === 0;
    download.addEventListener('click', () => downloadRecording(rec, download));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-quiet btn-danger';
    remove.textContent = 'ลบ';
    remove.disabled = busy;
    remove.addEventListener('click', () => deleteRecording(rec, remove));

    actions.append(download, remove);
    li.append(when, meta, actions);
    return li;
  }

  async function downloadRecording(rec, btn) {
    btn.disabled = true;
    try {
      const { url } = await api('POST', '/api/recordings/' + rec.id + '/ticket');
      location.href = url; // เซิร์ฟเวอร์ตอบเป็นไฟล์แนบ หน้านี้จึงไม่เปลี่ยน
    } catch (err) {
      toast(err.message);
    } finally {
      setTimeout(() => { btn.disabled = false; }, 1500);
    }
  }

  async function deleteRecording(rec, btn) {
    if (!confirm('ลบไฟล์บันทึกนี้? ลบแล้วกู้คืนไม่ได้')) return;
    btn.disabled = true;
    try {
      await api('DELETE', '/api/recordings/' + rec.id);
      toast('ลบไฟล์บันทึกแล้ว');
      load();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  }

  function formatDuration(sec) {
    if (sec == null) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(h ? 2 : 1, '0');
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0') + ' นาที';
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB';
  }

  let timer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove('show'), 2500);
  }
})();
