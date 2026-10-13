// Fotos, vídeos e galeria do simulador. A galeria fica guardada no próprio navegador (IndexedDB).

const DB_NAME = 'jarvis-fpv-gallery';

function openDb() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('items', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const t = db.transaction('items', mode);
      const r = fn(t.objectStore('items'));
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : null);
      t.onerror = t.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
}

const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function pickMime() {
  const opts = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  if (typeof MediaRecorder === 'undefined') return null;
  return opts.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

// Salva um arquivo: pela capacidade de downloads do Claude (quando a página roda como Artifact)
// ou por um link de download comum.
async function saveFile(filename, blob) {
  try {
    const dl = window.claude?.use ? await window.claude.use('downloads') : null;
    if (dl) { await dl.save({ filename, data: blob }); return 'saved'; }
  } catch (e) {
    if (e && e.code === 'declined') return 'declined';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'saved';
}

export function createMedia({ canvas, renderer, audio, onChange, setPixelRatio }) {
  const setPR = setPixelRatio || ((v) => renderer.setPixelRatio(v));
  const items = [];
  let db = null;
  const ready = openDb().then(async (d) => {
    db = d;
    const all = await tx(db, 'readonly', (s) => s.getAll());
    if (all) items.push(...all.sort((a, b) => b.created - a.created));
    onChange?.();
  });

  const pending = [];
  const rec = { on: false, t0: 0, recorder: null, chunks: [], thumb: null, mime: '', audioDest: null, onStop: null };

  async function thumbFrom(source, w, h) {
    const tw = 320, th = Math.round((tw * h) / w);
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    c.getContext('2d').drawImage(source, 0, 0, tw, th);
    return c.toDataURL('image/jpeg', 0.7);
  }

  async function store(item) {
    items.unshift(item);
    await tx(db, 'readwrite', (s) => s.put(item));
    onChange?.();
    return item;
  }

  // Chamado logo depois de cada renderer.render(): o buffer da imagem ainda é válido aqui.
  function afterRender(renderFn) {
    while (pending.length) pending.shift()(renderFn);
  }

  function photo(mult = 2) {
    return new Promise((resolve) => {
      pending.push((renderFn) => {
        const pr = renderer.getPixelRatio();
        const maxW = 4096;
        const target = Math.min(pr * mult, maxW / canvas.clientWidth);
        setPR(target);
        renderFn();
        const w = canvas.width, h = canvas.height;
        const thumbP = thumbFrom(canvas, w, h);
        canvas.toBlob(async (blob) => {
          if (!blob) return resolve(null);
          const item = { id: 'p' + Date.now(), kind: 'photo', name: `jarvis-fpv_${stamp()}.jpg`, created: Date.now(), blob, thumb: await thumbP, w, h, size: blob.size };
          resolve(await store(item));
        }, 'image/jpeg', 0.94);
        // toBlob já copiou a imagem; volta à resolução normal.
        setPR(pr);
      });
    });
  }

  function startRecording() {
    if (rec.on) return true;
    const mime = pickMime();
    if (mime === null || !canvas.captureStream) return false;
    const stream = canvas.captureStream(60);
    const ctx = audio();
    if (ctx && ctx.master) {
      try {
        rec.audioDest = ctx.ctx.createMediaStreamDestination();
        ctx.master.connect(rec.audioDest);
        rec.audioDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      } catch { rec.audioDest = null; }
    }
    let r;
    try { r = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 14e6 } : undefined); } catch { return false; }
    rec.recorder = r; rec.chunks = []; rec.mime = r.mimeType || mime || 'video/webm';
    rec.thumb = null;
    pending.push(async () => { rec.thumb = await thumbFrom(canvas, canvas.width, canvas.height); });
    r.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    r.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (rec.audioDest) { try { ctx.master.disconnect(rec.audioDest); } catch { /* já desconectado */ } rec.audioDest = null; }
      const blob = new Blob(rec.chunks, { type: rec.mime });
      const ext = rec.mime.includes('mp4') ? 'mp4' : 'webm';
      const dur = (performance.now() - rec.t0) / 1000;
      rec.on = false;
      onChange?.();
      if (blob.size) await store({ id: 'v' + Date.now(), kind: 'video', name: `jarvis-fpv_${stamp()}.${ext}`, created: Date.now(), blob, thumb: rec.thumb, duration: dur, size: blob.size });
      rec.onStop?.();
      rec.onStop = null;
    };
    r.start(1000);
    rec.on = true;
    rec.t0 = performance.now();
    onChange?.();
    return true;
  }

  function stopRecording(cb) {
    if (!rec.on || !rec.recorder) return;
    rec.onStop = cb || null;
    rec.recorder.stop();
  }

  async function remove(id) {
    const i = items.findIndex((x) => x.id === id);
    if (i >= 0) items.splice(i, 1);
    await tx(db, 'readwrite', (s) => s.delete(id));
    onChange?.();
  }

  return {
    ready, items, rec, afterRender, photo, startRecording, stopRecording, remove,
    save: (item) => saveFile(item.name, item.blob),
    get recording() { return rec.on; },
    get recTime() { return rec.on ? (performance.now() - rec.t0) / 1000 : 0; },
    canRecord: () => pickMime() !== null && !!canvas.captureStream,
  };
}
