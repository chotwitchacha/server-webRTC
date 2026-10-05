/*
 * Web client สำหรับห้องประชุม — ใช้ WebRTC ของเบราว์เซอร์ + Signaling protocol เดียวกับแอป Android
 * ทำงานเหมือน MeetingManager.java:
 *   - คนที่เข้าห้องทีหลังเป็นคนส่ง Offer ไปหาทุกคนที่อยู่ก่อน
 *   - ICE candidate ที่มาก่อน Offer/Answer จะถูกพักไว้ก่อน
 *   - ข้อความจาก Signaling ถูกประมวลผลทีละข้อความตามลำดับ (เหมือน executor thread เดียว)
 */
(function () {
  'use strict';

  const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    // ต้องตรงกับ TURN ในแอป ถ้ามี:
    // { urls: 'turn:your-turn-server:3478', username: 'user', credential: 'pass' },
  ];
  const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

  const roomId = decodeURIComponent(location.pathname.split('/')[2] || '');
  const $ = (id) => document.getElementById(id);

  const ui = {
    prejoin: $('prejoin'), meeting: $('meeting'), ended: $('ended'),
    preview: $('previewVideo'), previewMsg: $('previewMsg'),
    preMic: $('preMicBtn'), preCam: $('preCamBtn'), joinBtn: $('joinBtn'), joinError: $('joinError'),
    grid: $('grid'), status: $('status'), inviteBtn: $('inviteBtn'),
    micBtn: $('micBtn'), camBtn: $('camBtn'), switchBtn: $('switchBtn'), leaveBtn: $('leaveBtn'),
    soundBtn: $('soundBtn'),
    endedTitle: $('endedTitle'), endedMsg: $('endedMsg'), rejoinBtn: $('rejoinBtn'),
    toast: $('toast'),
  };

  const state = {
    localStream: null,
    micOn: true,
    camOn: true,
    facing: 'user',
    ws: null,
    queue: Promise.resolve(),
    peers: new Map(),    // peerId -> { pc, stream }
    pending: new Map(),  // peerId -> [candidate]
    tiles: new Map(),    // id -> { el, video }
    joined: false,
    leaving: false,
    wakeLock: null,
  };

  // ------------------------------------------------------------------
  // เริ่มต้น
  // ------------------------------------------------------------------
  if (!ROOM_ID_RE.test(roomId)) {
    showEnded('ลิงก์ไม่ถูกต้อง', 'Room ID ใช้ได้เฉพาะ a-z, 0-9, - และ _ ไม่เกิน 32 ตัว');
    return;
  }
  document.querySelectorAll('[data-room]').forEach((el) => { el.textContent = roomId; });

  ui.preMic.addEventListener('click', () => setMic(!state.micOn));
  ui.preCam.addEventListener('click', () => setCam(!state.camOn));
  ui.micBtn.addEventListener('click', () => setMic(!state.micOn));
  ui.camBtn.addEventListener('click', () => setCam(!state.camOn));
  ui.switchBtn.addEventListener('click', switchCamera);
  ui.joinBtn.addEventListener('click', join);
  ui.leaveBtn.addEventListener('click', () => leave('คุณออกจากห้องแล้ว', ''));
  ui.inviteBtn.addEventListener('click', invite);
  ui.rejoinBtn.addEventListener('click', () => location.reload());
  ui.soundBtn.addEventListener('click', playAllRemote);
  window.addEventListener('resize', relayout);
  window.addEventListener('pagehide', () => {
    if (state.joined && !state.leaving) {
      send({ type: 'leave' });
      if (state.ws) state.ws.close();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.joined && !state.leaving) requestWakeLock();
  });

  initPreview();

  // ------------------------------------------------------------------
  // กล้อง + ไมค์
  // ------------------------------------------------------------------
  function videoConstraints(facing) {
    return { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } };
  }

  async function getLocalMedia() {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('insecure context');
      err.name = 'InsecureContext';
      throw err;
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: videoConstraints(state.facing) });
    } catch (err) {
      // ไม่มีกล้อง หรือกล้องถูกใช้อยู่ -> ลองเสียงอย่างเดียว
      if (['NotFoundError', 'OverconstrainedError', 'NotReadableError'].includes(err.name)) {
        return await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      }
      throw err;
    }
  }

  function mediaErrorMessage(err) {
    switch (err.name) {
      case 'InsecureContext':
        return 'เบราว์เซอร์ให้ใช้กล้องและไมค์ได้เฉพาะลิงก์ https:// หรือ localhost '
          + 'ตอนนี้คุณยังเข้าห้องเพื่อดูและฟังคนอื่นได้';
      case 'NotAllowedError':
        return 'ยังไม่ได้อนุญาตให้ใช้กล้องและไมโครโฟน กดไอคอนข้างแถบที่อยู่เพื่ออนุญาต แล้วโหลดหน้านี้ใหม่';
      case 'NotFoundError':
        return 'ไม่พบกล้องหรือไมโครโฟนในเครื่องนี้ คุณยังเข้าห้องเพื่อดูและฟังได้';
      case 'NotReadableError':
        return 'กล้องหรือไมโครโฟนกำลังถูกใช้โดยแอปอื่น ปิดแอปนั้นแล้วโหลดหน้านี้ใหม่';
      default:
        return 'เปิดกล้องหรือไมโครโฟนไม่ได้ (' + err.name + ')';
    }
  }

  async function initPreview() {
    try {
      state.localStream = await getLocalMedia();
      ui.preview.srcObject = state.localStream;
      const hasVideo = state.localStream.getVideoTracks().length > 0;
      const hasAudio = state.localStream.getAudioTracks().length > 0;
      ui.preCam.disabled = !hasVideo;
      ui.preMic.disabled = !hasAudio;
      if (!hasVideo) {
        state.camOn = false;
        ui.previewMsg.textContent = 'ไม่พบกล้อง จะเข้าร่วมด้วยเสียงอย่างเดียว';
      }
      if (!hasAudio) state.micOn = false;
      ui.joinBtn.textContent = 'เข้าร่วมประชุม';
    } catch (err) {
      console.warn('getUserMedia failed', err);
      state.localStream = null;
      state.micOn = false;
      state.camOn = false;
      ui.preMic.disabled = true;
      ui.preCam.disabled = true;
      ui.previewMsg.textContent = mediaErrorMessage(err);
      ui.joinBtn.textContent = 'เข้าร่วมแบบดูและฟังอย่างเดียว';
    }
    syncControls();
    ui.joinBtn.disabled = false;
  }

  function setMic(on) {
    if (!state.localStream || state.localStream.getAudioTracks().length === 0) return;
    state.micOn = on;
    state.localStream.getAudioTracks().forEach((t) => { t.enabled = on; });
    syncControls();
  }

  function setCam(on) {
    if (!state.localStream || state.localStream.getVideoTracks().length === 0) return;
    state.camOn = on;
    // enabled = false -> ส่งเฟรมดำให้คนอื่น (เหมือน setEnabled(false) ในแอป)
    state.localStream.getVideoTracks().forEach((t) => { t.enabled = on; });
    syncControls();
  }

  function syncControls() {
    const hasAudio = !!state.localStream && state.localStream.getAudioTracks().length > 0;
    const hasVideo = !!state.localStream && state.localStream.getVideoTracks().length > 0;

    setLabel(ui.preMic, !state.micOn, state.micOn ? 'ไมค์เปิด' : 'ไมค์ปิด');
    setLabel(ui.preCam, !state.camOn, state.camOn ? 'กล้องเปิด' : 'กล้องปิด');
    setLabel(ui.micBtn, !state.micOn, state.micOn ? 'ปิดไมค์' : 'เปิดไมค์');
    setLabel(ui.camBtn, !state.camOn, state.camOn ? 'ปิดกล้อง' : 'เปิดกล้อง');
    ui.micBtn.disabled = !hasAudio;
    ui.camBtn.disabled = !hasVideo;

    ui.preview.style.visibility = hasVideo && state.camOn ? 'visible' : 'hidden';
    const local = state.tiles.get('local');
    if (local) local.el.classList.toggle('no-video', !hasVideo || !state.camOn);
  }

  function setLabel(btn, off, text) {
    btn.classList.toggle('off', off);
    btn.querySelector('.label').textContent = text;
  }

  async function switchCamera() {
    if (!state.localStream) return;
    const oldTrack = state.localStream.getVideoTracks()[0];
    if (!oldTrack) return;
    const nextFacing = state.facing === 'user' ? 'environment' : 'user';
    ui.switchBtn.disabled = true;

    // มือถือหลายรุ่นเปิดกล้อง 2 ตัวพร้อมกันไม่ได้ จึงต้องปิดตัวเดิมก่อน
    oldTrack.stop();
    let newTrack;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(nextFacing) });
      newTrack = s.getVideoTracks()[0];
      state.facing = nextFacing;
    } catch (err) {
      console.warn('switch camera failed', err);
      const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(state.facing) });
      newTrack = s.getVideoTracks()[0];
      toast('สลับกล้องไม่ได้');
    }
    newTrack.enabled = state.camOn;

    // เปลี่ยน track ที่ส่งให้ทุกคน โดยไม่ต้องเจรจา (renegotiate) ใหม่
    for (const { pc } of state.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
    }
    state.localStream.removeTrack(oldTrack);
    state.localStream.addTrack(newTrack);

    const local = state.tiles.get('local');
    if (local) {
      local.video.srcObject = state.localStream;
      local.el.classList.toggle('mirror', state.facing === 'user');
    }
    ui.switchBtn.disabled = false;
  }

  async function updateSwitchButton() {
    if (!state.localStream || state.localStream.getVideoTracks().length === 0) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      ui.switchBtn.hidden = devices.filter((d) => d.kind === 'videoinput').length < 2;
    } catch (e) { /* ไม่แสดงปุ่ม */ }
  }

  // ------------------------------------------------------------------
  // เข้าห้อง + Signaling
  // ------------------------------------------------------------------
  function join() {
    state.joined = true;
    ui.prejoin.hidden = true;
    ui.meeting.hidden = false;
    ui.preview.srcObject = null;

    addTile('local', 'คุณ', state.localStream || new MediaStream(), true);
    syncControls();
    updateSwitchButton();
    ui.status.textContent = 'กำลังเชื่อมต่อ...';
    requestWakeLock();
    connectSignaling();
  }

  function connectSignaling() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host);
    state.ws = ws;

    ws.onopen = () => send({ type: 'join', room: roomId });
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      // ประมวลผลทีละข้อความตามลำดับ
      state.queue = state.queue.then(() => handleMessage(msg)).catch((err) => console.error(err));
    };
    ws.onclose = () => {
      if (!state.leaving) leave('การเชื่อมต่อหลุด', 'ตรวจสอบอินเทอร์เน็ต แล้วกดเข้าร่วมอีกครั้ง');
    };
  }

  function send(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
  }

  async function handleMessage(msg) {
    if (state.leaving) return;
    switch (msg.type) {
      case 'joined':
        updateStatus();
        // เราเข้ามาทีหลัง -> เราเป็นคนส่ง Offer ไปหาทุกคน
        for (const peerId of msg.peers) await callPeer(peerId);
        break;
      case 'peer-joined':
        break; // รอคนใหม่ส่ง Offer มาหาเรา
      case 'peer-left':
        closePeer(msg.id);
        break;
      case 'offer':
        await onOffer(msg.from, msg.sdp);
        break;
      case 'answer':
        await onAnswer(msg.from, msg.sdp);
        break;
      case 'candidate':
        await onCandidate(msg.from, msg);
        break;
      case 'error':
        leave('เข้าห้องไม่ได้', msg.message || '');
        break;
    }
  }

  // ------------------------------------------------------------------
  // PeerConnection
  // ------------------------------------------------------------------
  function createPeer(peerId, isOfferer) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { pc, stream: new MediaStream() };
    state.peers.set(peerId, entry);

    const stream = state.localStream;
    const hasAudio = !!stream && stream.getAudioTracks().length > 0;
    const hasVideo = !!stream && stream.getVideoTracks().length > 0;
    if (stream) stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    // ฝั่งที่ส่ง Offer แต่ไม่มีกล้อง/ไมค์ ต้องบอกว่า "ขอรับอย่างเดียว" ไม่อย่างนั้นจะไม่ได้ภาพ/เสียงคนอื่น
    if (isOfferer) {
      if (!hasAudio) pc.addTransceiver('audio', { direction: 'recvonly' });
      if (!hasVideo) pc.addTransceiver('video', { direction: 'recvonly' });
    }

    pc.onicecandidate = (e) => {
      if (!e.candidate || !e.candidate.candidate) return;
      send({
        type: 'candidate',
        to: peerId,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex ?? 0,
        candidate: e.candidate.candidate,
      });
    };

    pc.ontrack = (e) => {
      entry.stream.addTrack(e.track);
      addTile(peerId, 'ผู้เข้าร่วม ' + peerId.slice(0, 4), entry.stream, false);
    };

    pc.onconnectionstatechange = () => {
      console.log('peer', peerId, pc.connectionState);
      if (pc.connectionState === 'failed') toast('เชื่อมต่อกับผู้เข้าร่วมบางคนไม่สำเร็จ');
    };

    return entry;
  }

  async function callPeer(peerId) {
    const { pc } = createPeer(peerId, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'offer', to: peerId, sdp: pc.localDescription.sdp });
  }

  async function onOffer(fromId, sdp) {
    const entry = state.peers.get(fromId) || createPeer(fromId, false);
    const pc = entry.pc;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await drainCandidates(fromId, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'answer', to: fromId, sdp: pc.localDescription.sdp });
  }

  async function onAnswer(fromId, sdp) {
    const entry = state.peers.get(fromId);
    if (!entry) return;
    await entry.pc.setRemoteDescription({ type: 'answer', sdp });
    await drainCandidates(fromId, entry.pc);
  }

  async function onCandidate(fromId, msg) {
    const candidate = { candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex };
    const entry = state.peers.get(fromId);
    if (!entry || !entry.pc.remoteDescription) {
      if (!state.pending.has(fromId)) state.pending.set(fromId, []);
      state.pending.get(fromId).push(candidate);
      return;
    }
    try { await entry.pc.addIceCandidate(candidate); } catch (err) { console.warn('addIceCandidate', err); }
  }

  async function drainCandidates(peerId, pc) {
    const list = state.pending.get(peerId);
    state.pending.delete(peerId);
    if (!list) return;
    for (const c of list) {
      try { await pc.addIceCandidate(c); } catch (err) { console.warn('addIceCandidate', err); }
    }
  }

  function closePeer(peerId) {
    const entry = state.peers.get(peerId);
    state.peers.delete(peerId);
    state.pending.delete(peerId);
    if (entry) entry.pc.close();
    removeTile(peerId);
  }

  // ------------------------------------------------------------------
  // Grid วิดีโอ
  // ------------------------------------------------------------------
  function addTile(id, label, stream, isLocal) {
    let tile = state.tiles.get(id);
    if (!tile) {
      const el = document.createElement('figure');
      el.className = 'tile' + (isLocal && state.facing === 'user' ? ' mirror' : '');

      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('playsinline', ''); // iOS Safari
      if (isLocal) video.muted = true;       // ไม่ให้ได้ยินเสียงตัวเอง

      const off = document.createElement('div');
      off.className = 'cam-off';
      off.textContent = 'กล้องปิดอยู่';

      const name = document.createElement('figcaption');
      name.className = 'name';
      name.textContent = label;

      el.append(video, off, name);
      ui.grid.appendChild(el);
      tile = { el, video, isLocal };
      state.tiles.set(id, tile);
      relayout();
    }
    if (tile.video.srcObject !== stream) tile.video.srcObject = stream;
    const playing = tile.video.play();
    if (playing && !isLocal) {
      // บางเบราว์เซอร์ (โดยเฉพาะ iOS) ไม่ยอมเล่นเสียงอัตโนมัติ
      playing.catch(() => { ui.soundBtn.hidden = false; });
    }
  }

  function removeTile(id) {
    const tile = state.tiles.get(id);
    if (!tile) return;
    tile.video.srcObject = null;
    tile.el.remove();
    state.tiles.delete(id);
    relayout();
  }

  function playAllRemote() {
    for (const tile of state.tiles.values()) {
      if (!tile.isLocal) tile.video.play().catch(() => {});
    }
    ui.soundBtn.hidden = true;
  }

  // 1 คน = เต็มจอ, 2 คน = บน/ล่าง (จอแนวตั้ง) หรือ ซ้าย/ขวา (จอแนวนอน), 3-4 คน = 2x2, 5-6 คน = 2x3 / 3x2
  function relayout() {
    const n = state.tiles.size;
    if (n === 0) return;
    const portrait = window.innerHeight > window.innerWidth;
    let cols;
    if (n === 1) cols = 1;
    else if (n === 2) cols = portrait ? 1 : 2;
    else if (n <= 4) cols = 2;
    else cols = portrait ? 2 : 3;
    const rows = Math.ceil(n / cols);
    ui.grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    ui.grid.style.gridTemplateRows = 'repeat(' + rows + ', minmax(0, 1fr))';
    updateStatus();
  }

  function updateStatus() {
    if (state.joined) ui.status.textContent = 'ผู้เข้าร่วม ' + state.tiles.size + ' คน';
  }

  // ------------------------------------------------------------------
  // เชิญ / ออก / อื่นๆ
  // ------------------------------------------------------------------
  async function invite() {
    const url = location.origin + '/join/' + encodeURIComponent(roomId);
    if (navigator.share) {
      try {
        await navigator.share({ title: 'เชิญเข้าห้องประชุม', text: 'เข้าห้องประชุม ' + roomId, url });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('คัดลอกลิงก์เชิญแล้ว');
    } catch (err) {
      window.prompt('คัดลอกลิงก์นี้', url);
    }
  }

  function leave(title, message) {
    if (state.leaving) return;
    state.leaving = true;
    send({ type: 'leave' });
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
    }
    for (const peerId of [...state.peers.keys()]) closePeer(peerId);
    if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
    releaseWakeLock();
    showEnded(title, message);
  }

  function showEnded(title, message) {
    ui.prejoin.hidden = true;
    ui.meeting.hidden = true;
    ui.ended.hidden = false;
    ui.endedTitle.textContent = title;
    ui.endedMsg.textContent = message;
    ui.rejoinBtn.hidden = !ROOM_ID_RE.test(roomId);
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) { /* ไม่รองรับ หรือหน้าไม่ได้อยู่ด้านหน้า */ }
  }

  function releaseWakeLock() {
    if (state.wakeLock) state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }

  let toastTimer = null;
  function toast(text) {
    ui.toast.textContent = text;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2500);
  }
})();
