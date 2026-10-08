/*
 * MeetingRecorder — บันทึกการประชุมในเบราว์เซอร์ของผู้สร้างห้อง
 *
 * วิธีทำงาน
 *   ภาพ : วาดวิดีโอทุกคนลง <canvas> แบบตาราง 15 เฟรม/วินาที แล้วใช้ canvas.captureStream()
 *   เสียง: รวมเสียงทุกคน (รวมของตัวเอง) ด้วย Web Audio API
 *   ไฟล์ : MediaRecorder ตัดไฟล์ทุก 15 วินาที แล้วอัปโหลดขึ้นเซิร์ฟเวอร์ทีละชิ้นตามลำดับ
 *          ระหว่างประชุมจึงไม่ต้องเก็บไฟล์ทั้งก้อนไว้ในเครื่อง และถ้าหลุดกลางคันยังได้ส่วนที่อัปโหลดแล้ว
 */
(function () {
  'use strict';

  const CHUNK_MS = 15000;
  const FPS = 15;
  const WIDTH = 1280;
  const HEIGHT = 720;
  const GAP = 8;

  function pickMimeType() {
    if (!window.MediaRecorder) return null;
    const candidates = [
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm',
      'video/mp4;codecs=avc1,mp4a', // Safari
      'video/mp4',
    ];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class MeetingRecorder {
    /**
     * @param {{roomId:string, peerId:string, hostToken:string,
     *          getTiles:()=>Array<{video:HTMLVideoElement,label:string,showVideo:boolean}>,
     *          onError:(msg:string)=>void}} opts
     */
    constructor(opts) {
      this.opts = opts;
      this.recId = null;
      this.recorder = null;
      this.seq = 0;
      this.queue = Promise.resolve();
      this.sources = new Map(); // audio track id -> MediaStreamAudioSourceNode
      this.failedParts = 0;
    }

    static isSupported() {
      return !!pickMimeType()
        && typeof HTMLCanvasElement.prototype.captureStream === 'function'
        && !!(window.AudioContext || window.webkitAudioContext);
    }

    async api(method, url, body) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: 'Bearer ' + this.opts.hostToken,
          'Content-Type': body instanceof Blob ? 'application/octet-stream' : 'application/json',
        },
        body: body instanceof Blob ? body : (body ? JSON.stringify(body) : undefined),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      return data;
    }

    async start(streams) {
      const mimeType = pickMimeType();
      if (!mimeType) throw new Error('เบราว์เซอร์นี้บันทึกวิดีโอไม่ได้');

      const { id } = await this.api('POST', '/api/rooms/' + encodeURIComponent(this.opts.roomId) + '/recordings', {
        peerId: this.opts.peerId,
        mimeType,
      });
      this.recId = id;

      try {
        // ภาพ
        this.canvas = document.createElement('canvas');
        this.canvas.width = WIDTH;
        this.canvas.height = HEIGHT;
        this.ctx = this.canvas.getContext('2d');
        this.draw();
        this.drawTimer = setInterval(() => this.draw(), 1000 / FPS);
        const videoTrack = this.canvas.captureStream(FPS).getVideoTracks()[0];

        // เสียง
        const AC = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AC();
        await this.audioCtx.resume();
        this.audioDest = this.audioCtx.createMediaStreamDestination();
        this.syncAudio(streams);

        const mixed = new MediaStream([videoTrack, ...this.audioDest.stream.getAudioTracks()]);
        this.recorder = new MediaRecorder(mixed, {
          mimeType,
          videoBitsPerSecond: 800000,
          audioBitsPerSecond: 64000,
        });
        this.stopped = new Promise((resolve) => { this.recorder.onstop = resolve; });
        this.recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) this.enqueue(e.data);
        };
        this.recorder.start(CHUNK_MS);
      } catch (err) {
        this.cleanup();
        await this.api('POST', '/api/recordings/' + this.recId + '/stop').catch(() => {});
        throw err;
      }
    }

    /** เรียกทุกครั้งที่มีคนเข้า/ออก เพื่อเพิ่ม/ตัดเสียงของคนนั้น */
    syncAudio(streams) {
      if (!this.audioCtx) return;
      const live = new Set();
      for (const stream of streams) {
        if (!stream) continue;
        for (const track of stream.getAudioTracks()) {
          if (track.readyState !== 'live') continue;
          live.add(track.id);
          if (this.sources.has(track.id)) continue;
          const source = this.audioCtx.createMediaStreamSource(new MediaStream([track]));
          source.connect(this.audioDest);
          this.sources.set(track.id, source);
        }
      }
      for (const [id, source] of this.sources) {
        if (!live.has(id)) {
          source.disconnect();
          this.sources.delete(id);
        }
      }
    }

    draw() {
      const ctx = this.ctx;
      const tiles = this.opts.getTiles();
      ctx.fillStyle = '#131C24';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      const n = tiles.length;
      if (n === 0) return;
      const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
      const rows = Math.ceil(n / cols);
      const cw = (WIDTH - GAP * (cols + 1)) / cols;
      const ch = (HEIGHT - GAP * (rows + 1)) / rows;

      tiles.forEach((tile, i) => {
        const x = GAP + (i % cols) * (cw + GAP);
        const y = GAP + Math.floor(i / cols) * (ch + GAP);
        ctx.fillStyle = '#1A252F';
        ctx.fillRect(x, y, cw, ch);

        const v = tile.video;
        if (tile.showVideo && v.readyState >= 2 && v.videoWidth > 0) {
          // ครอปให้เต็มช่องแบบ object-fit: cover
          const vr = v.videoWidth / v.videoHeight;
          const cr = cw / ch;
          let sx = 0, sy = 0, sw = v.videoWidth, sh = v.videoHeight;
          if (vr > cr) { sw = sh * cr; sx = (v.videoWidth - sw) / 2; }
          else { sh = sw / cr; sy = (v.videoHeight - sh) / 2; }
          ctx.drawImage(v, sx, sy, sw, sh, x, y, cw, ch);
        } else {
          ctx.fillStyle = '#94A4B2';
          ctx.font = '500 22px "IBM Plex Sans Thai", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('กล้องปิดอยู่', x + cw / 2, y + ch / 2);
        }

        ctx.font = '500 18px "IBM Plex Sans Thai", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(tile.label).width + 16;
        ctx.fillStyle = 'rgba(10, 16, 22, 0.7)';
        ctx.fillRect(x + 10, y + ch - 42, w, 30);
        ctx.fillStyle = '#E8EEF2';
        ctx.fillText(tile.label, x + 18, y + ch - 27);
      });
    }

    enqueue(blob) {
      const seq = this.seq++;
      this.queue = this.queue.then(() => this.upload(seq, blob));
    }

    async upload(seq, blob) {
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          await this.api('POST', '/api/recordings/' + this.recId + '/parts?seq=' + seq, blob);
          return;
        } catch (err) {
          if (attempt === 4) {
            this.failedParts++;
            this.opts.onError('อัปโหลดไฟล์บันทึกบางช่วงไม่สำเร็จ: ' + err.message);
            return;
          }
          await sleep(1000 * attempt * attempt);
        }
      }
    }

    /** หยุดบันทึก รอให้อัปโหลดช่วงสุดท้ายเสร็จ แล้วแจ้งเซิร์ฟเวอร์ */
    async stop() {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop();
        await this.stopped;
      }
      await this.queue;
      this.cleanup();
      if (this.recId) await this.api('POST', '/api/recordings/' + this.recId + '/stop');
      return { failedParts: this.failedParts };
    }

    cleanup() {
      clearInterval(this.drawTimer);
      for (const source of this.sources.values()) source.disconnect();
      this.sources.clear();
      if (this.canvas) this.canvas.width = 0;
      if (this.audioCtx) this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  window.MeetingRecorder = MeetingRecorder;
})();
