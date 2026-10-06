/* ==========================================================================
   JARVIS · Personal Intelligence — UI v0.1
   JavaScript puro, organizado em módulos (objetos) independentes:

   Utils · Store · Settings · Sound · Effects(ripple) · Clock · Core · Particles
   Wave · Router · Toast · Notify · Modal · Brain · Home · Chat · Projects
   Memory · Vision · Devices · System · SettingsUI · Boot · Keys · App

   Nada aqui acessa câmera, microfone, arquivos ou APIs externas.
   Tudo que é "inteligente" é simulado localmente (ver módulo Brain).
   ========================================================================== */
'use strict';

(() => {

  /* ======================================================================
     UTILS
     ====================================================================== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const randi = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const pad = (n) => String(n).padStart(2, '0');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const hhmm = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const hhmmss = (d = new Date()) => `${hhmm(d)}:${pad(d.getSeconds())}`;
  const icon = (id) => `<svg><use href="#i-${id}"/></svg>`;
  const MONTHS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
  const WEEK = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];

  const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  };
  const relTime = (ts) => {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'agora';
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
  };

  /** Ajusta o canvas à densidade de pixels e devolve contexto + dimensões CSS */
  const fitCanvas = (canvas) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  };

  /** Cor de destaque atual (lida das variáveis CSS do tema) */
  const Theme = {
    h: 192, s: '100%',
    refresh() {
      const cs = getComputedStyle(document.body);
      this.h = parseFloat(cs.getPropertyValue('--h')) || 192;
      this.s = cs.getPropertyValue('--s').trim() || '100%';
    },
    c(alpha = 1, light = 60, hue = this.h) { return `hsla(${hue}, ${this.s}, ${light}%, ${alpha})`; },
  };

  /* Barramento de eventos simples entre módulos */
  const Bus = {
    map: {},
    on(evt, fn) { (this.map[evt] = this.map[evt] || []).push(fn); },
    emit(evt, data) { (this.map[evt] || []).forEach((fn) => fn(data)); },
  };

  /* ======================================================================
     STORE — persistência local (localStorage com fallback em memória)
     ====================================================================== */
  const Store = {
    key: 'jarvis.ui.v2',
    data: {},
    load() {
      try { this.data = JSON.parse(localStorage.getItem(this.key)) || {}; } catch { this.data = {}; }
    },
    get(k, fallback) { return k in this.data ? this.data[k] : fallback; },
    set(k, v) {
      this.data[k] = v;
      try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch { /* armazenamento indisponível */ }
    },
  };

  /* ======================================================================
     SETTINGS — valores e aplicação no DOM
     ====================================================================== */
  const Settings = {
    defaults: {
      animations: true, boot: true, city: true, particles: true, scanlines: true, grid: false,
      sound: true, volume: 0.4, intensity: 1, density: 0.6, mode: 'padrao',
      userName: 'José Marcelo', locMode: 'auto', location: 'Ivinhema, MS', claudeTier: 'quick',
      voiceReply: 'voice', voiceRate: 0, ttsEngine: 'auto', continuous: true, wakeWord: false, bargeIn: true, micMode: 'always',
    },
    v: {},
    load() { this.v = { ...this.defaults, ...Store.get('settings', {}) }; },
    set(k, val) {
      this.v[k] = val;
      Store.set('settings', this.v);
      this.apply();
      Bus.emit('settings', { key: k, value: val });
    },
    reset() {
      this.v = { ...this.defaults };
      Store.set('settings', this.v);
      this.apply();
      Bus.emit('settings', { key: '*' });
    },
    apply() {
      const b = document.body, v = this.v;
      b.classList.toggle('no-anim', !v.animations);
      b.classList.toggle('no-particles', !v.particles);
      b.classList.toggle('no-scanlines', !v.scanlines);
      b.classList.toggle('no-grid', !v.grid);
      b.classList.toggle('no-city', !v.city);
      b.style.setProperty('--gi', v.intensity);
      b.dataset.mode = v.mode;
      Theme.refresh();
      const snd = $('#topWave');
      if (snd) snd.classList.toggle('off', !v.sound);
    },
  };

  /* ======================================================================
     SOUND — bipes sintetizados com Web Audio (sem arquivos, sem microfone)
     ====================================================================== */
  const Sound = {
    ctx: null,
    unlocked: false, // navegadores só liberam áudio após um gesto do usuário
    init() {
      const unlock = () => { this.unlocked = true; };
      window.addEventListener('pointerdown', unlock, { once: true, capture: true });
      window.addEventListener('keydown', unlock, { once: true, capture: true });
    },
    presets: {
      click:   [[880, 0.04, 'sine', 0.25]],
      nav:     [[520, 0.05, 'triangle', 0.3], [1040, 0.06, 'sine', 0.18, 0.04]],
      send:    [[660, 0.05, 'sine', 0.3], [990, 0.08, 'sine', 0.25, 0.05]],
      receive: [[990, 0.05, 'sine', 0.22], [740, 0.09, 'sine', 0.2, 0.06]],
      notify:  [[1320, 0.06, 'sine', 0.22], [1760, 0.1, 'sine', 0.16, 0.08]],
      error:   [[220, 0.12, 'square', 0.12], [180, 0.16, 'square', 0.1, 0.1]],
      boot:    [[220, 0.25, 'sine', 0.25], [440, 0.25, 'sine', 0.2, 0.18], [880, 0.4, 'sine', 0.18, 0.36]],
      scan:    [[1500, 0.03, 'sine', 0.12]],
      toggle:  [[700, 0.035, 'triangle', 0.25]],
    },
    ensure() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { this.ctx = new AC(); } catch { this.ctx = null; }
      return this.ctx;
    },
    play(name) {
      if (!this.unlocked || !Settings.v.sound || Settings.v.volume <= 0) return;
      const ctx = this.ensure();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume();
      const vol = Settings.v.volume;
      (this.presets[name] || this.presets.click).forEach(([freq, dur, type, gain, delay = 0]) => {
        const t = ctx.currentTime + delay;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain * vol, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(g).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur + 0.02);
      });
    },
  };

  /* ======================================================================
     EFFECTS — ripple de clique e som de clique genérico
     ====================================================================== */
  const Effects = {
    init() {
      document.addEventListener('pointerdown', (e) => {
        const el = e.target.closest('.btn, .chip, .nav-item, .send-btn, .modes button, .segmented button');
        if (!el || !Settings.v.animations) return;
        const r = el.getBoundingClientRect();
        const size = Math.max(r.width, r.height);
        const sp = document.createElement('span');
        sp.className = 'ripple';
        sp.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
        el.appendChild(sp);
        sp.addEventListener('animationend', () => sp.remove());
      });
      document.addEventListener('click', (e) => {
        if (e.target.closest('.btn, .chip, .icon-btn, .segmented button, .mem-cat, .proj')) Sound.play('click');
      });
    },
  };

  /* ======================================================================
     CLOCK — relógio, data, saudação e uptime
     ====================================================================== */
  const Clock = {
    start: Date.now(),
    tick() {
      const d = new Date();
      $('#clockHM').textContent = hhmm(d);
      $('#clockSec').textContent = ':' + pad(d.getSeconds());
      $('#clockDate').textContent = `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      $('#camClock').textContent = `SEM SINAL · ${hhmmss(d)}`;
      this.greet(d);
    },
    greet(d = new Date()) {
      const h = d.getHours();
      const part = h < 5 ? 'evening' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
      const txt = `Good ${part}, ${Settings.v.userName || 'Sir'}.`;
      const el = $('#greeting');
      if (el.textContent !== txt) el.textContent = txt;
    },
    init() {
      this.tick();
      setInterval(() => this.tick(), 1000);
      Bus.on('settings', () => this.greet());
    },
  };

  /* ======================================================================
     CORE — estado do núcleo (ready, thinking, listening, speaking, offline, boot)
     ====================================================================== */
  const Core = {
    state: 'boot',
    labels: {
      ready:     { sub: 'READY',       pill: 'ONLINE',  hud: 'ONLINE',  chat: 'AGUARDANDO' },
      thinking:  { sub: 'PENSANDO',    pill: 'BUSY',    hud: 'ONLINE',  chat: 'PENSANDO' },
      searching: { sub: 'PESQUISANDO', pill: 'SEARCH',  hud: 'ONLINE',  chat: 'PESQUISANDO' },
      reading:   { sub: 'LENDO FONTES', pill: 'READ',   hud: 'ONLINE',  chat: 'LENDO FONTES' },
      processing:{ sub: 'PROCESSANDO', pill: 'BUSY',    hud: 'ONLINE',  chat: 'PROCESSANDO' },
      executing: { sub: 'EXECUTANDO',  pill: 'EXEC',    hud: 'ONLINE',  chat: 'EXECUTANDO' },
      waiting:   { sub: 'AGUARDANDO',  pill: 'CONFIRM', hud: 'ONLINE',  chat: 'AGUARDANDO CONFIRMAÇÃO' },
      error:     { sub: 'ERRO',        pill: 'ERRO',    hud: 'ONLINE',  chat: 'ERRO' },
      listening: { sub: 'OUVINDO',     pill: 'LISTEN',  hud: 'ONLINE',  chat: 'OUVINDO' },
      speaking:  { sub: 'RESPONDENDO', pill: 'ACTIVE',  hud: 'ONLINE',  chat: 'RESPONDENDO' },
      offline:   { sub: 'OFFLINE',     pill: 'OFFLINE', hud: 'OFFLINE', chat: 'NÚCLEO OFFLINE' },
      nomodel:   { sub: 'SEM MODELO',  pill: 'SEM IA',  hud: 'ONLINE',  chat: 'MODELO INDISPONÍVEL' },
      boot:      { sub: 'BOOT',        pill: 'BOOT',    hud: 'INICIANDO', chat: 'INICIANDO' },
    },
    amp: 0,
    set(state) {
      if (!this.labels[state]) return;
      this.state = state;
      document.body.dataset.core = state;
      const L = this.labels[state];
      $('#coreSub').textContent = L.sub;
      $('#coreIndicatorText').textContent = L.pill;
      $('#chatState').textContent = L.chat;
      Bus.emit('core', state);
    },
    isBusy() { return !['ready', 'nomodel', 'waiting', 'error', 'offline'].includes(this.state); },
    /** Fase do backend (IDLE, THINKING, SEARCHING...) → estado visual do núcleo. */
    PHASES: { LISTENING: 'listening', THINKING: 'thinking', SEARCHING: 'searching', READING: 'reading', PROCESSING: 'processing',
              SPEAKING: 'speaking', EXECUTING: 'executing', WAITING_CONFIRMATION: 'waiting', ERROR: 'error' },
    phase(p) {
      if (!Boot.done) return;
      let st = this.PHASES[p] || Backend.baseState();
      if (Voice.out.speaking && ['processing', 'ready', 'nomodel'].includes(st)) st = 'speaking';   // a fala tem prioridade visual
      else if (Voice.in.active && ['ready', 'nomodel'].includes(st)) st = 'listening';
      this.set(st);
      clearTimeout(this._errT);
      if (st === 'error') this._errT = setTimeout(() => { if (this.state === 'error') this.set(Backend.baseState()); }, 2500);
    },
    /** Loop de amplitude: simula energia vocal quando ouvindo/falando */
    loop() {
      const target = this.state === 'speaking' ? rand(0.35, 1)
        : this.state === 'listening' ? rand(0.15, 0.8)
        : ['thinking', 'searching', 'reading', 'processing', 'executing'].includes(this.state) ? rand(0.05, 0.25) : 0;
      this.amp += (target - this.amp) * 0.25;
      $('#core').style.setProperty('--amp', this.amp.toFixed(3));
      requestAnimationFrame(() => this.loop());
    },
    init() {
      const core = $('#core');
      const orbit = $('.core-wrap');
      // Inclinação 3D sutil seguindo o mouse — dá sensação de "presença"
      orbit.addEventListener('pointermove', (e) => {
        if (!Settings.v.animations) return;
        const r = core.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
        const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
        core.style.setProperty('--ry', `${clamp(dx * 14, -12, 12)}deg`);
        core.style.setProperty('--rx', `${clamp(-dy * 14, -12, 12)}deg`);
      });
      orbit.addEventListener('pointerleave', () => {
        core.style.setProperty('--ry', '0deg');
        core.style.setProperty('--rx', '0deg');
      });
      core.addEventListener('click', () => {   // o núcleo leva direto à conversa
        Router.go('conversa');
      });
      this.loop();
    },
  };

  /* ======================================================================
     PARTICLES — campo de partículas de fundo com conexões
     ====================================================================== */
  const Particles = {
    canvas: null, ctx: null, w: 0, h: 0, list: [], mouse: { x: -999, y: -999 },
    build() {
      const fit = fitCanvas(this.canvas);
      this.ctx = fit.ctx; this.w = fit.w; this.h = fit.h;
      const n = Math.round(clamp((this.w * this.h) / 15000, 30, 130) * Settings.v.density);
      this.list = Array.from({ length: n }, () => ({
        x: Math.random() * this.w, y: Math.random() * this.h,
        vx: rand(-0.15, 0.15), vy: rand(-0.15, 0.15),
        r: rand(0.6, 1.8), a: rand(0.25, 0.9), tw: rand(0, Math.PI * 2),
      }));
    },
    frame() {
      requestAnimationFrame(() => this.frame());
      if (!Settings.v.particles || document.hidden) return;
      const { ctx, w, h, list, mouse } = this;
      ctx.clearRect(0, 0, w, h);
      const speed = Core.state === 'thinking' ? 3 : 1;
      for (const p of list) {
        p.x += p.vx * speed; p.y += p.vy * speed; p.tw += 0.02;
        if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
        const dx = p.x - mouse.x, dy = p.y - mouse.y, d2 = dx * dx + dy * dy;
        if (d2 < 14000) { p.x += dx * 0.004; p.y += dy * 0.004; } // leve repulsão
      }
      ctx.lineWidth = 0.6;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
          if (d2 < 11000) {
            ctx.strokeStyle = Theme.c((1 - d2 / 11000) * 0.16);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }
      for (const p of list) {
        ctx.fillStyle = Theme.c(p.a * (0.6 + Math.sin(p.tw) * 0.4), 70);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
    },
    init() {
      this.canvas = $('#bgParticles');
      this.build();
      let t;
      window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => this.build(), 150); });
      window.addEventListener('pointermove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
      Bus.on('settings', ({ key }) => { if (key === 'density' || key === '*') this.build(); });
      this.frame();
    },
  };

  /* ======================================================================
     WAVE — forma de onda de voz (reage ao estado do núcleo)
     ====================================================================== */
  const Wave = {
    canvas: null, t: 0, active: false,
    frame() {
      requestAnimationFrame(() => this.frame());
      if (!this.active || document.hidden) return;
      const { ctx, w, h } = fitCanvas(this.canvas);
      ctx.clearRect(0, 0, w, h);
      this.t += 0.05;
      const mid = h / 2;
      const span = w * 0.62;                      // largura da parte "viva" da onda
      const x0 = (w - span) / 2;
      const bars = Math.floor(span / 3);
      const energy = 0.22 + Core.amp * 0.85;
      // trilha pontilhada nas pontas
      ctx.fillStyle = Theme.c(0.45, 65);
      for (let x = 0; x < w; x += 4) {
        if (x > x0 - 2 && x < x0 + span) continue;
        const fade = x < x0 ? x / x0 : (w - x) / x0;
        ctx.globalAlpha = 0.15 + fade * 0.6;
        ctx.fillRect(x, mid - 0.75, 2, 1.5);
      }
      ctx.globalAlpha = 1;
      for (let i = 0; i < bars; i++) {
        const x = x0 + i * 3;
        const c = 1 - Math.abs(i - bars / 2) / (bars / 2);
        const n = Math.sin(i * 0.42 + this.t * 2.2) * 0.5 + Math.sin(i * 0.13 - this.t * 1.4) * 0.35 + Math.sin(i * 1.7 + this.t * 4) * 0.15;
        const amp = Math.max(0.05, Math.abs(n) * energy * Math.pow(c, 1.1) + Math.random() * 0.08 * c * (0.4 + Core.amp));
        const bh = amp * h;
        ctx.fillStyle = Theme.c(0.35 + c * 0.65, 55 + c * 15);
        ctx.fillRect(x, mid - bh / 2, 2, bh);
      }
    },
    init() { this.canvas = $('#wave'); this.frame(); },
  };

  /* ======================================================================
     CITY — cenário de fundo: laboratório com vista noturna da cidade
     Desenhado proceduralmente em canvas (sem imagens externas).
     ====================================================================== */
  const City = {
    canvas: null,
    draw() {
      const { ctx, w, h } = fitCanvas(this.canvas);
      let seed = 11;
      const R = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
      const hz = h * 0.64;                                   // linha do horizonte
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#01030a'); sky.addColorStop(0.5, '#030c1a'); sky.addColorStop(0.64, '#0a1b31'); sky.addColorStop(0.66, '#040a14'); sky.addColorStop(1, '#010309');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
      const glow = ctx.createRadialGradient(w * 0.55, hz, 0, w * 0.55, hz, w * 0.55);
      glow.addColorStop(0, 'rgba(255,150,80,.10)'); glow.addColorStop(0.45, 'rgba(40,120,220,.07)'); glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);

      const layer = (minH, maxH, color, winRate, alpha) => {
        let x = -10;
        while (x < w) {
          const bw = 16 + R() * 50;
          const tall = R() < 0.12;
          const bh = minH + (tall ? 0.7 + R() * 0.3 : R() * R()) * (maxH - minH);
          const top = hz - bh;
          ctx.fillStyle = color; ctx.fillRect(x, top, bw, bh);
          for (let wy = top + 4; wy < hz - 3; wy += 5) {
            for (let wx = x + 3; wx < x + bw - 3; wx += 4) {
              if (R() < winRate) {
                ctx.fillStyle = R() < 0.62 ? `rgba(255,${170 + R() * 40 | 0},110,${(0.25 + R() * 0.55) * alpha})` : `rgba(120,195,255,${(0.2 + R() * 0.5) * alpha})`;
                ctx.fillRect(wx, wy, 1.6, 2.2);
              }
            }
          }
          if (tall && R() < 0.6) { // antena com luz vermelha
            ctx.fillStyle = color; ctx.fillRect(x + bw / 2 - 1, top - 26, 2, 26);
            ctx.fillStyle = 'rgba(255,70,70,.9)'; ctx.fillRect(x + bw / 2 - 1.5, top - 28, 3, 3);
          }
          x += bw + R() * 5;
        }
      };
      ctx.filter = 'blur(1.4px)';
      layer(18, h * 0.16, '#071423', 0.10, 0.7);
      ctx.filter = 'blur(0.6px)';
      layer(26, h * 0.30, '#040b16', 0.16, 1);
      ctx.filter = 'none';

      // piso do laboratório + reflexos
      const sill = h * 0.70;
      const floor = ctx.createLinearGradient(0, sill, 0, h);
      floor.addColorStop(0, '#050d18'); floor.addColorStop(1, '#010308');
      ctx.fillStyle = floor; ctx.fillRect(0, sill, w, h - sill);
      for (let i = 0; i < 60; i++) {
        const x = R() * w;
        const g = ctx.createLinearGradient(0, sill, 0, h);
        const c = R() < 0.6 ? '255,170,100' : '90,170,255';
        g.addColorStop(0, `rgba(${c},.10)`); g.addColorStop(1, `rgba(${c},0)`);
        ctx.fillStyle = g; ctx.fillRect(x, sill, 1 + R() * 2, (h - sill) * (0.3 + R() * 0.7));
      }
      // linhas de luz no piso (estilo laboratório)
      ctx.shadowColor = 'rgba(70,160,255,.9)'; ctx.shadowBlur = 12;
      ctx.fillStyle = 'rgba(110,190,255,.55)';
      [[0.70, 0.78, 0.24], [0.80, 0.86, 0.20], [0.03, 0.62, 0.16]].forEach(([y, x, len]) => ctx.fillRect(w * x, h * y + h * 0.1, w * len, 2));
      ctx.shadowBlur = 0;
      // caixilhos das janelas
      const cols = Math.max(3, Math.round(w / 260));
      for (let i = 1; i < cols; i++) {
        const x = (w / cols) * i;
        const g = ctx.createLinearGradient(x - 9, 0, x + 9, 0);
        g.addColorStop(0, '#010307'); g.addColorStop(0.5, '#071321'); g.addColorStop(1, '#010307');
        ctx.fillStyle = g; ctx.fillRect(x - 9, 0, 18, sill);
      }
      ctx.fillStyle = '#020610'; ctx.fillRect(0, sill - 6, w, 8);
      ctx.fillStyle = 'rgba(80,160,240,.15)'; ctx.fillRect(0, sill - 6, w, 1);
      ctx.fillStyle = '#02060e'; ctx.fillRect(0, h * 0.26, w, 5);
    },
    init() {
      this.canvas = $('#bgCity');
      this.draw();
      let t;
      window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => this.draw(), 200); });
    },
  };

  /* ======================================================================
     GEO — continentes simplificados (lon, lat) para globo e mapa
     ====================================================================== */
  const Geo = {
    polys: [
      [[-168,66],[-156,71],[-140,70],[-120,70],[-95,72],[-80,73],[-62,66],[-55,52],[-66,45],[-70,42],[-76,35],[-81,31],[-80,25],[-83,29],[-90,30],[-97,27],[-97,21],[-92,18],[-87,21],[-84,15],[-83,10],[-79,8],[-80,7],[-85,10],[-92,14],[-105,20],[-110,24],[-115,31],[-118,34],[-124,40],[-124,48],[-130,55],[-140,60],[-152,58],[-158,56],[-165,60]],
      [[-55,60],[-44,60],[-20,70],[-18,80],[-40,83],[-60,82],[-70,77],[-55,70]],
      [[-24,64],[-14,64],[-14,66.5],[-22,66.5]],
      [[-80,8],[-72,12],[-62,10],[-50,0],[-35,-5],[-38,-13],[-40,-22],[-48,-26],[-53,-34],[-58,-38],[-65,-42],[-68,-50],[-70,-55],[-74,-50],[-73,-40],[-72,-30],[-70,-18],[-76,-14],[-81,-5],[-80,0]],
      [[-10,36],[-9,43],[-2,44],[-5,48],[2,51],[8,54],[8,57],[5,62],[12,66],[20,70],[30,71],[40,68],[45,60],[40,48],[30,45],[28,41],[22,37],[20,40],[16,38],[18,40],[12,44],[8,44],[3,43],[-2,37]],
      [[-5,50],[2,51],[0,54],[-3,58],[-6,57],[-5,54]],
      [[-17,21],[-16,12],[-8,5],[5,4],[9,4],[10,-2],[13,-12],[12,-18],[15,-27],[20,-35],[27,-34],[33,-26],[36,-18],[40,-15],[40,-5],[44,2],[51,12],[43,12],[38,18],[33,28],[32,31],[20,32],[10,37],[0,36],[-6,36],[-10,30]],
      [[44,-25],[47,-25],[50,-15],[48,-13]],
      [[28,41],[36,37],[35,32],[43,13],[52,16],[57,22],[60,25],[67,24],[72,20],[77,8],[80,15],[88,22],[92,22],[98,16],[100,6],[104,1],[104,10],[109,12],[108,21],[118,24],[122,31],[120,38],[126,38],[130,43],[140,47],[142,53],[136,55],[150,59],[163,60],[170,65],[180,66],[180,70],[160,71],[140,73],[110,77],[100,79],[80,73],[70,73],[60,70],[45,68],[40,66],[45,60],[40,48],[50,45],[47,40]],
      [[130,31],[135,34],[140,36],[142,40],[140,42],[136,37],[131,34]],
      [[95,5],[105,-6],[115,-8],[120,-9],[118,-3],[110,-2],[105,0]],
      [[114,-22],[122,-18],[130,-12],[137,-12],[142,-11],[146,-19],[153,-26],[151,-33],[146,-39],[138,-35],[132,-32],[124,-34],[115,-34],[113,-26]],
      [[172,-41],[175,-37],[178,-38],[174,-46],[167,-46]],
    ],
    cities: {
      home: [-53.83, -22.30], sp: [-46.63, -23.55], ny: [-74, 40.7], la: [-118.2, 34], mx: [-99.1, 19.4], bo: [-74.1, 4.7], ba: [-58.4, -34.6],
      lo: [-0.1, 51.5], mo: [37.6, 55.8], lg: [3.4, 6.5], ca: [18.4, -33.9], du: [55.3, 25.2], mu: [72.8, 19],
      sg: [103.8, 1.35], to: [139.7, 35.7], sy: [151.2, -33.9],
    },
    routes: [['home','ny'],['home','lo'],['home','sp'],['home','lg'],['sp','ba'],['ny','lo'],['lo','du'],['du','sg'],['sg','to'],['to','la'],['la','ny'],['sg','sy'],['lo','mo'],['mx','bo'],['bo','home'],['ca','lg'],['mu','du'],['mx','la']],
    pip(lon, lat, poly) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    },
    sample(step) {
      const pts = [];
      for (let lat = -56; lat <= 82; lat += step) {
        const ls = step / Math.max(Math.cos((lat * Math.PI) / 180), 0.25);
        for (let lon = -180; lon < 180; lon += ls) {
          if (this.polys.some((p) => this.pip(lon, lat, p))) pts.push([lon, lat]);
        }
      }
      return pts;
    },
  };

  /* ======================================================================
     GLOBE — globo holográfico rotativo com rotas e satélite
     ====================================================================== */
  const Globe = {
    canvas: null, pts: [], active: false, lon0: -52, lat0: -14, t: 0,
    proj(lon, lat) {
      const d = Math.PI / 180, l = (lon - this.lon0) * d, p = lat * d, c = this.lat0 * d;
      return [
        Math.cos(p) * Math.sin(l),
        Math.cos(c) * Math.sin(p) - Math.sin(c) * Math.cos(p) * Math.cos(l),
        Math.sin(c) * Math.sin(p) + Math.cos(c) * Math.cos(p) * Math.cos(l),
      ];
    },
    satellite(ctx, x, y) {
      ctx.save();
      ctx.translate(x, y + Math.sin(this.t * 1.3) * 3);
      ctx.rotate(-0.6 + Math.sin(this.t * 0.5) * 0.05);
      ctx.strokeStyle = Theme.c(0.9, 78); ctx.lineWidth = 1;
      [-1, 1].forEach((sd) => {
        const x0 = sd < 0 ? -34 : 10;
        ctx.fillStyle = Theme.c(0.22, 55);
        ctx.fillRect(x0, -7, 24, 14); ctx.strokeRect(x0, -7, 24, 14);
        ctx.beginPath();
        for (let i = 1; i < 4; i++) { ctx.moveTo(x0 + i * 6, -7); ctx.lineTo(x0 + i * 6, 7); }
        ctx.moveTo(x0, 0); ctx.lineTo(x0 + 24, 0); ctx.stroke();
      });
      ctx.fillStyle = '#0c2440'; ctx.fillRect(-9, -9, 18, 18); ctx.strokeRect(-9, -9, 18, 18);
      ctx.beginPath(); ctx.moveTo(0, 9); ctx.lineTo(0, 17); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 19, 3, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = Theme.c(0.9 * (0.5 + 0.5 * Math.sin(this.t * 4)), 80);
      ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    },
    frame() {
      requestAnimationFrame(() => this.frame());
      if (!this.active || document.hidden) return;
      const { ctx, w, h } = fitCanvas(this.canvas);
      ctx.clearRect(0, 0, w, h);
      this.t += 0.016;
      const [hLon, hLat] = Geo.cities.home;
      const tLon = hLon + 10 + (Settings.v.animations ? Math.sin(this.t * 0.12) * 38 : 0);
      this.lon0 += (tLon - this.lon0) * 0.04;
      this.lat0 += (clamp(hLat * 0.7, -30, 30) - this.lat0) * 0.04;
      const R = Math.min(w * 0.4, h * 0.46);
      const cx = w * 0.46, cy = h * 0.53;

      // órbita (parte de trás)
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.42);
      ctx.strokeStyle = Theme.c(0.22); ctx.setLineDash([2, 5]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(0, 0, R * 1.32, R * 0.44, 0, Math.PI, Math.PI * 2); ctx.stroke();
      ctx.restore(); ctx.setLineDash([]);

      // halo + esfera
      const halo = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.32);
      halo.addColorStop(0, Theme.c(0.28 * Settings.v.intensity)); halo.addColorStop(1, Theme.c(0));
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.32, 0, Math.PI * 2); ctx.fill();
      const sph = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R);
      sph.addColorStop(0, `hsl(${Theme.h}, 70%, 16%)`); sph.addColorStop(0.7, `hsl(${Theme.h}, 75%, 7%)`); sph.addColorStop(1, `hsl(${Theme.h}, 80%, 4%)`);
      ctx.fillStyle = sph; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

      // gratícula
      ctx.fillStyle = Theme.c(0.18, 65);
      for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 4) {
        const [x, y, z] = this.proj(lon, lat); if (z > 0) ctx.fillRect(cx + x * R, cy - y * R, 1, 1);
      }
      for (let lon = -180; lon < 180; lon += 30) for (let lat = -80; lat <= 80; lat += 4) {
        const [x, y, z] = this.proj(lon, lat); if (z > 0) ctx.fillRect(cx + x * R, cy - y * R, 1, 1);
      }
      // continentes
      for (const [lon, lat] of this.pts) {
        const [x, y, z] = this.proj(lon, lat);
        if (z <= 0) continue;
        ctx.fillStyle = Theme.c(0.25 + 0.75 * z, 62 + z * 18);
        ctx.fillRect(cx + x * R - 0.9, cy - y * R - 0.9, 1.8, 1.8);
      }
      // borda iluminada
      ctx.shadowColor = Theme.c(1); ctx.shadowBlur = 14 * Settings.v.intensity;
      ctx.strokeStyle = Theme.c(0.75, 70); ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;

      // rotas com pulsos
      const C = Geo.cities;
      Geo.routes.forEach(([a, b], idx) => {
        const A = C[a], B = C[b];
        const pts = [];
        for (let i = 0; i <= 24; i++) {
          const k = i / 24;
          const [x, y, z] = this.proj(A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k);
          const lift = 1 + Math.sin(Math.PI * k) * 0.12;
          pts.push([cx + x * R * lift, cy - y * R * lift, z]);
        }
        if (pts[0][2] < 0.05 || pts[24][2] < 0.05) return;
        ctx.strokeStyle = Theme.c(0.5, 72); ctx.lineWidth = 0.9;
        ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
        const pk = Math.floor(((this.t * 0.35 + idx * 0.17) % 1) * 24);
        ctx.fillStyle = Theme.c(1, 85);
        ctx.beginPath(); ctx.arc(pts[pk][0], pts[pk][1], 1.8, 0, Math.PI * 2); ctx.fill();
      });
      // cidades
      Object.entries(C).forEach(([id, [lon, lat]]) => {
        const [x, y, z] = this.proj(lon, lat);
        if (z <= 0.02) return;
        const px = cx + x * R, py = cy - y * R;
        ctx.shadowColor = Theme.c(1); ctx.shadowBlur = 8;
        ctx.fillStyle = Theme.c(0.6 + z * 0.4, 82);
        ctx.beginPath(); ctx.arc(px, py, id === 'home' ? 3 : 1.9, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        if (id === 'home') {
          ctx.font = '600 11px Rajdhani, sans-serif'; ctx.fillStyle = Theme.c(0.95, 85); ctx.textAlign = 'left';
          ctx.fillText(Location.loc ? Location.loc.name : '', px + 8, py - 6);
          const k = (this.t % 1.8) / 1.8;
          ctx.strokeStyle = Theme.c(1 - k, 75); ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(px, py, 4 + k * 14, 0, Math.PI * 2); ctx.stroke();
        }
      });

      // órbita (parte da frente) + satélite
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.42);
      ctx.strokeStyle = Theme.c(0.35); ctx.setLineDash([2, 5]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(0, 0, R * 1.32, R * 0.44, 0, 0, Math.PI); ctx.stroke();
      ctx.restore(); ctx.setLineDash([]);
      this.satellite(ctx, cx + R * 0.98, cy - R * 0.98);
    },
    init() { this.canvas = $('#globe'); this.pts = Geo.sample(2.6); this.frame(); },
  };

  /* ======================================================================
     WORLD MAP — mapa global com camadas (rede, alvos, varredura, dados)
     ====================================================================== */
  const WorldMap = {
    canvas: null, pts: [], active: false, layer: 'net', t: 0, latMin: -56, latMax: 80,
    labels: { net: 'REDE', nodes: 'ALVOS', radar: 'VARREDURA', data: 'DADOS' },
    xy(lon, lat, w, h) { return [((lon + 180) / 360) * w, ((this.latMax - lat) / (this.latMax - this.latMin)) * h]; },
    frame() {
      requestAnimationFrame(() => this.frame());
      if (!this.active || document.hidden) return;
      const { ctx, w, h } = fitCanvas(this.canvas);
      ctx.clearRect(0, 0, w, h);
      this.t += 0.016;
      ctx.fillStyle = Theme.c(0.34, 62);
      for (const [lon, lat] of this.pts) {
        const [x, y] = this.xy(lon, lat, w, h);
        ctx.fillRect(x - 0.7, y - 0.7, 1.4, 1.4);
      }
      const C = Geo.cities;
      const P = {};
      Object.entries(C).forEach(([id, [lon, lat]]) => { P[id] = this.xy(lon, lat, w, h); });

      if (this.layer === 'net') {
        Geo.routes.forEach(([a, b], idx) => {
          const [x1, y1] = P[a], [x2, y2] = P[b];
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - Math.hypot(x2 - x1, y2 - y1) * 0.28;
          ctx.strokeStyle = Theme.c(0.42, 70); ctx.lineWidth = 0.8;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(mx, my, x2, y2); ctx.stroke();
          const k = (this.t * 0.3 + idx * 0.13) % 1, q = 1 - k;
          ctx.fillStyle = Theme.c(1, 85);
          ctx.beginPath(); ctx.arc(q * q * x1 + 2 * q * k * mx + k * k * x2, q * q * y1 + 2 * q * k * my + k * k * y2, 1.6, 0, Math.PI * 2); ctx.fill();
        });
      }
      if (this.layer === 'radar') {
        const sx = ((this.t * 0.18) % 1) * w;
        const g = ctx.createLinearGradient(sx - 60, 0, sx, 0);
        g.addColorStop(0, Theme.c(0)); g.addColorStop(1, Theme.c(0.3));
        ctx.fillStyle = g; ctx.fillRect(sx - 60, 0, 60, h);
        ctx.fillStyle = Theme.c(0.9, 75); ctx.fillRect(sx, 0, 1.2, h);
      }
      Object.entries(P).forEach(([id, [x, y]], i) => {
        let r = id === 'home' ? 2.8 : 1.8;
        if (this.layer === 'radar') {
          const sx = ((this.t * 0.18) % 1) * w;
          const d = sx - x;
          if (d > 0 && d < 50) r += (1 - d / 50) * 3;
        }
        if (this.layer === 'data') {
          const v = (Math.sin(this.t * 1.5 + i * 1.3) * 0.5 + 0.5) * h * 0.22 + 4;
          const g = ctx.createLinearGradient(0, y - v, 0, y);
          g.addColorStop(0, Theme.c(0)); g.addColorStop(1, Theme.c(0.8, 70));
          ctx.fillStyle = g; ctx.fillRect(x - 1.5, y - v, 3, v);
        }
        ctx.shadowColor = Theme.c(1); ctx.shadowBlur = 8;
        ctx.fillStyle = Theme.c(1, 80);
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        if (this.layer === 'nodes' || id === 'home') {
          const k = ((this.t + i * 0.37) % 2) / 2;
          ctx.strokeStyle = Theme.c(1 - k, 75); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(x, y, 3 + k * 12, 0, Math.PI * 2); ctx.stroke();
        }
      });
    },
    init() {
      this.canvas = $('#worldMap');
      this.pts = Geo.sample(2.2);
      $('#mapTools').addEventListener('click', (e) => {
        const b = e.target.closest('[data-layer]');
        if (!b) return;
        this.layer = b.dataset.layer;
        $$('#mapTools button').forEach((x) => x.classList.toggle('on', x === b));
        $('#mapLabel').textContent = this.labels[this.layer];
        Sound.play('scan');
      });
      this.frame();
    },
  };

  /* ======================================================================
     HOME UI — painéis da tela inicial (notificações, projetos, dispositivos, feed, câmera)
     ====================================================================== */
  const HomeUI = {
    projIcons: { jarvis: 'cpu', 'axiom-sight': 'eye', 'dum-e': 'robot', 'ar-interface': 'glasses' },
    feed: [],
    FEED_MAP: {
      JARVIS_READY: (p) => ['cpu', 'Núcleo online', `v${p.version || ''} · ${p.model_available ? 'IA disponível' : 'sem modelo de IA'}`, 'var(--ok)'],
      MESSAGE_RECEIVED: (p) => ['chat', 'Mensagem recebida', `${p.chars || 0} caracteres`, ''],
      AI_RESPONSE: (p) => ['spark', 'Resposta enviada', p.tool ? `via ferramenta ${p.tool}` : p.route === 'llm' ? 'via IA' : p.route, ''],
      TOOL_FINISHED: (p) => ['chip', `Ferramenta: ${p.tool}`, p.ok ? 'executada com sucesso' : `falhou (${p.code})`, p.ok ? '' : 'var(--warn)'],
      MEMORY_UPDATED: (p) => ['memory', 'Memória atualizada', p.source === 'chat' ? 'salva pela conversa' : 'alterada pela interface', 'var(--ok)'],
      PROJECT_UPDATED: (p) => ['folder', 'Projeto atualizado', p.project || '', ''],
      CONFIRMATION_REQUIRED: (p) => ['alert', 'Confirmação pendente', `ferramenta ${p.tool}`, 'var(--warn)'],
      AI_ERROR: (p) => ['alert', 'Erro do modelo', p.code || '', 'var(--bad)'],
      DEVICE_CONNECTED: (p) => ['devices', 'Dispositivo conectado', p.device || '', 'var(--ok)'],
      MODEL_STATUS: (p) => ['cpu', 'Status do modelo', p.available ? 'disponível' : 'indisponível', p.available ? 'var(--ok)' : 'var(--warn)'],
    },
    pushEvent(ev) {
      const f = this.FEED_MAP[ev.type];
      if (!f) return;
      const [ic, title, sub, color] = f(ev.payload || {});
      if (this.feed.some((x) => x.ts === ev.ts && x.title === title)) return;
      this.feed.unshift({ icon: ic, title, sub, color: color || 'var(--a)', ts: Date.parse(ev.ts) || Date.now() });
      this.feed = this.feed.slice(0, 4);
      this.renderFeed();
    },
    notifs() {
      const ul = $('#homeNotifs');
      if (!ul) return;
      const items = Notify.items.slice(0, 3);
      ul.innerHTML = items.length ? items.map((n) => {
        const T = TYPES[n.type] || TYPES.info;
        return `<li data-id="${n.id}" ${T.color ? `style="--nc:${T.color}"` : ''}>
          <span class="ring-ico">${icon(T.icon)}</span>
          <div><div class="mn-title">${esc(n.title)}</div><div class="mn-sub">${esc(n.sub || '')}</div></div>
          <span class="mn-time">${hhmm(new Date(n.ts))}</span></li>`;
      }).join('') : '<li class="mini-empty">Nenhuma notificação.</li>';
    },
    projects() {
      const ul = $('#homeProjects');
      if (!ul) return;
      if (!Projects.loaded) { ul.innerHTML = '<li class="mini-empty">Núcleo offline.</li>'; return; }
      ul.innerHTML = Projects.items.slice(0, 4).map((p) => `<li data-slug="${esc(p.slug)}">
          <span class="ml-ico ring">${icon(this.projIcons[p.slug] || 'folder')}</span>
          <div style="min-width:0"><div class="ml-title up">${esc(p.subtitle || p.name)}</div><div class="ml-sub">${esc(p.status)} · ${p.progress}%</div></div>
          <span class="ml-right" title="${p.progress}%"><svg class="pring" viewBox="0 0 26 26"><circle class="bg" cx="13" cy="13" r="10"/><circle class="fg" cx="13" cy="13" r="10" style="stroke-dashoffset:${(62.83 * (1 - p.progress / 100)).toFixed(2)}"/></svg></span>
        </li>`).join('') || '<li class="mini-empty">Nenhum projeto.</li>';
    },
    devices() {
      const ul = $('#homeDevices');
      if (!ul) return;
      if (!Devices.loaded) { ul.innerHTML = '<li class="mini-empty">Núcleo offline.</li>'; return; }
      const list = [...Devices.items].sort((a, b) => (a.status === 'connected' ? 0 : 1) - (b.status === 'connected' ? 0 : 1)).slice(0, 4);
      ul.innerHTML = list.map((d) => {
        const on = d.status === 'connected';
        const b = d.info?.battery;
        return `<li class="${on ? '' : 'li-off'}" data-id="${esc(d.id)}">
          <span class="ml-ico">${icon(d.icon)}</span>
          <div style="min-width:0"><div class="ml-title">${esc(d.name)}</div><div class="ml-sub">${on ? 'Conectado' : 'Não conectado'}</div></div>
          <span class="ml-right">${b ? `<span class="mbatt ${b.percent < 40 ? 'low' : ''}"><i style="--b:${b.percent}%"></i></span>${b.percent}%` : on ? 'AC' : '—'}</span>
        </li>`;
      }).join('');
    },
    renderFeed() {
      const ul = $('#homeFeed');
      if (!this.feed.length) { ul.innerHTML = `<li class="mini-empty">${Backend.online ? 'Aguardando eventos do núcleo…' : 'Núcleo offline.'}</li>`; return; }
      ul.innerHTML = this.feed.map((f) => `<li style="--nc:${f.color}">
        <span class="ml-ico">${icon(f.icon)}</span>
        <div style="min-width:0"><div class="ml-title">${esc(f.title)}</div><div class="ml-sub">${esc(f.sub)}</div></div>
        <span class="ml-right dim">${relTime(f.ts)}</span></li>`).join('');
    },
    snap() {
      Sound.play('error');
      Toast.show({ type: 'warn', title: 'Câmera não conectada', sub: 'Sinal óptico ausente. A câmera real entra na FASE 6.', target: 'visao' }, 3000);
    },
    init() {
      this.renderFeed();
      setInterval(() => this.renderFeed(), 30000);
      Bus.on('backend', async ({ online }) => {
        if (!online) { this.renderFeed(); return; }
        try { (await Api.get('/api/events/recent?limit=30')).items.forEach((ev) => this.pushEvent(ev)); } catch { this.renderFeed(); }
      });
      $('#homeNotifs').addEventListener('click', (e) => {
        const li = e.target.closest('li[data-id]');
        if (!li) return;
        const item = Notify.items.find((i) => i.id === Number(li.dataset.id));
        if (item) { item.read = true; Notify.render(); if (item.target) Router.go(item.target); }
      });
      $('#homeNotifAll').addEventListener('click', () => Notify.open());
      $('#homeProjects').addEventListener('click', (e) => {
        const li = e.target.closest('li[data-slug]');
        if (li) { Router.go('projetos'); setTimeout(() => Projects.detail(li.dataset.slug), 250); }
      });
      $('#homeDevices').addEventListener('click', () => Router.go('dispositivos'));
      $('#homeFeed').addEventListener('click', () => Router.go('sistema'));
      $('#camSnap').addEventListener('click', (e) => { e.stopPropagation(); this.snap(); });
      $('#camFeed').addEventListener('click', () => Router.go('visao'));
      this.notifs(); this.projects(); this.devices();
    },
  };

  /* ======================================================================
     LOCATION — localização real + clima ao vivo
     Ordem no modo automático: GPS do navegador → IP → última salva → padrão.
     APIs gratuitas e sem chave:
       • Open-Meteo (clima e busca de cidades)  https://open-meteo.com
       • BigDataCloud (GPS → nome da cidade)     https://www.bigdatacloud.com
       • ipwho.is (localização aproximada por IP)
     Se a rede estiver bloqueada, usa a última localização salva / tabela local.
     ====================================================================== */
  const UF = {
    'acre': 'AC', 'alagoas': 'AL', 'amapa': 'AP', 'amazonas': 'AM', 'bahia': 'BA', 'ceara': 'CE', 'distrito federal': 'DF',
    'espirito santo': 'ES', 'goias': 'GO', 'maranhao': 'MA', 'mato grosso': 'MT', 'mato grosso do sul': 'MS', 'minas gerais': 'MG',
    'para': 'PA', 'paraiba': 'PB', 'parana': 'PR', 'pernambuco': 'PE', 'piaui': 'PI', 'rio de janeiro': 'RJ',
    'rio grande do norte': 'RN', 'rio grande do sul': 'RS', 'rondonia': 'RO', 'roraima': 'RR', 'santa catarina': 'SC',
    'sao paulo': 'SP', 'sergipe': 'SE', 'tocantins': 'TO',
  };
  const WMO = { // código de tempo → [descrição, ícone]
    0: ['Céu limpo', 'clear'], 1: ['Predominantemente limpo', 'clear'], 2: ['Parcialmente nublado', 'partly'], 3: ['Nublado', 'cloud'],
    45: ['Neblina', 'fog'], 48: ['Neblina com geada', 'fog'], 51: ['Garoa fraca', 'rain'], 53: ['Garoa', 'rain'], 55: ['Garoa forte', 'rain'],
    56: ['Garoa congelante', 'rain'], 57: ['Garoa congelante', 'rain'], 61: ['Chuva fraca', 'rain'], 63: ['Chuva', 'rain'], 65: ['Chuva forte', 'rain'],
    66: ['Chuva congelante', 'rain'], 67: ['Chuva congelante', 'rain'], 71: ['Neve fraca', 'cloud'], 73: ['Neve', 'cloud'], 75: ['Neve forte', 'cloud'],
    77: ['Grãos de neve', 'cloud'], 80: ['Pancadas de chuva', 'rain'], 81: ['Pancadas de chuva', 'rain'], 82: ['Pancadas fortes', 'storm'],
    85: ['Neve', 'cloud'], 86: ['Neve forte', 'cloud'], 95: ['Trovoada', 'storm'], 96: ['Trovoada com granizo', 'storm'], 99: ['Trovoada com granizo', 'storm'],
  };
  const KNOWN = { // usada quando não há internet para buscar a cidade
    'ivinhema': [-22.30127, -53.82866, 'Ivinhema', 'MS'], 'nova andradina': [-22.2332, -53.3437, 'Nova Andradina', 'MS'],
    'dourados': [-22.2211, -54.8056, 'Dourados', 'MS'], 'campo grande': [-20.4697, -54.6201, 'Campo Grande', 'MS'],
    'sao paulo': [-23.5505, -46.6333, 'São Paulo', 'SP'], 'rio de janeiro': [-22.9068, -43.1729, 'Rio de Janeiro', 'RJ'],
    'curitiba': [-25.4284, -49.2733, 'Curitiba', 'PR'], 'brasilia': [-15.7939, -47.8828, 'Brasília', 'DF'],
  };
  const SOURCE_LABEL = { gps: 'GPS', ip: 'IP', manual: 'MANUAL', saved: 'SALVA', default: 'PADRÃO' };

  const Location = {
    loc: null,      // { name, uf, cc, lat, lon, source, ts }
    wx: null,       // { temp, code, hum, wind, isDay, ts, live }
    busy: false,
    async getJSON(url, ms = 8000) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } finally { clearTimeout(t); }
    },
    ufOf(region) { return UF[norm(region || '')] || ''; },
    label(l = this.loc) { return l ? `${l.name}${l.uf ? ', ' + l.uf : l.cc && l.cc !== 'BR' ? ', ' + l.cc : ''}` : '—'; },
    gps() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('sem geolocalização'));
        navigator.geolocation.getCurrentPosition(
          (p) => resolve([p.coords.latitude, p.coords.longitude]),
          (e) => reject(e),
          { enableHighAccuracy: false, timeout: 9000, maximumAge: 10 * 60000 },
        );
      });
    },
    async reverse(lat, lon) {
      const d = await this.getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=pt`);
      const sub = (d.principalSubdivisionCode || '').split('-')[1] || this.ufOf(d.principalSubdivision);
      return { name: d.city || d.locality || 'Local atual', uf: d.countryCode === 'BR' ? sub : '', cc: d.countryCode || '' };
    },
    async byIP() {
      const d = await this.getJSON('https://ipwho.is/?lang=pt-BR');
      if (!d.success) throw new Error('ip falhou');
      return { name: d.city, uf: d.country_code === 'BR' ? (d.region_code || this.ufOf(d.region)) : '', cc: d.country_code, lat: d.latitude, lon: d.longitude };
    },
    async geocode(query) {
      const q = String(query || '').trim();
      const [city, hint] = q.split(',').map((x) => x.trim());
      const known = KNOWN[norm(city)];
      try {
        const d = await this.getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10&language=pt&format=json`);
        let list = d.results || [];
        if (hint) {
          const h = norm(hint);
          const m = list.filter((r) => norm(r.admin1 || '') === h || this.ufOf(r.admin1).toLowerCase() === h || norm(r.country_code || '') === h);
          if (m.length) list = m;
        }
        const br = list.find((r) => r.country_code === 'BR');
        const r = br || list[0];
        if (r) return { name: r.name, uf: r.country_code === 'BR' ? this.ufOf(r.admin1) : '', cc: r.country_code, lat: r.latitude, lon: r.longitude };
      } catch { /* sem rede — tenta a tabela local */ }
      if (known) return { name: known[2], uf: known[3], cc: 'BR', lat: known[0], lon: known[1] };
      throw new Error('Cidade não encontrada');
    },
    async weather() {
      if (!this.loc) return;
      const { lat, lon } = this.loc;
      try {
        const d = await this.getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,is_day&timezone=auto`);
        const c = d.current;
        this.wx = { temp: c.temperature_2m, code: c.weather_code, hum: c.relative_humidity_2m, wind: c.wind_speed_10m, isDay: !!c.is_day, ts: Date.now(), live: true };
        Store.set('weather', { ...this.wx, at: `${lat},${lon}` });
      } catch {
        const cached = Store.get('weather', null);
        if (cached && cached.at === `${lat},${lon}` && Date.now() - cached.ts < 3 * 3600000) {
          this.wx = { ...cached, live: false };
        } else {
          const h = new Date().getHours();
          this.wx = { temp: 24, code: 2, hum: 62, wind: 9, isDay: h >= 6 && h < 18, ts: Date.now(), live: false, simulated: true };
        }
      }
      this.render();
    },
    nearestKnown(lat, lon) {
      let best = null, bd = Infinity;
      Object.values(KNOWN).forEach(([la, lo, name, uf]) => {
        const d = Math.hypot(la - lat, (lo - lon) * Math.cos((lat * Math.PI) / 180)) * 111;
        if (d < bd) { bd = d; best = { name, uf, cc: 'BR' }; }
      });
      return bd < 25 ? best : null;
    },
    async detect({ notify = false } = {}) {
      if (this.busy) { this.pending = { notify }; return; }
      this.busy = true;
      $('#locRefresh').classList.add('spinning');
      this.status('Localizando…');
      let loc = null, why = '';
      try {
        if (Settings.v.locMode === 'manual') {
          loc = { ...(await this.geocode(Settings.v.location || 'Ivinhema, MS')), source: 'manual' };
        } else {
          try {
            const [lat, lon] = await this.gps();
            let place = { name: 'Local atual', uf: '', cc: '' };
            try { place = await this.reverse(lat, lon); } catch { place = this.nearestKnown(lat, lon) || place; }
            loc = { ...place, lat, lon, source: 'gps' };
          } catch (e) {
            why = e && e.code === 1 ? 'permissão de localização negada' : 'GPS indisponível';
            try { loc = { ...(await this.byIP()), source: 'ip' }; } catch { why += ' · IP indisponível'; }
          }
        }
      } catch (e) { why = e.message; }
      if (!loc) {
        const saved = Store.get('loc', null);
        loc = saved ? { ...saved, source: 'saved' } : { name: 'Ivinhema', uf: 'MS', cc: 'BR', lat: -22.30127, lon: -53.82866, source: 'default' };
      }
      loc.ts = Date.now();
      const changed = !this.loc || this.label(loc) !== this.label();
      this.loc = loc;
      if (loc.source !== 'saved' && loc.source !== 'default') Store.set('loc', loc);
      Geo.cities.home = [loc.lon, loc.lat];
      this.render();
      this.status(`Fonte: ${SOURCE_LABEL[loc.source]}${why ? ' (' + why + ')' : ''} · ${hhmm()}`);
      await this.weather();
      $('#locRefresh').classList.remove('spinning');
      this.busy = false;
      if (notify || (changed && loc.source !== 'saved' && loc.source !== 'default' && this.started)) {
        Toast.show({ type: 'ok', title: 'Localização atualizada', sub: `${this.label()} · via ${SOURCE_LABEL[loc.source]}` }, 3000);
      }
      this.started = true;
      if (this.pending) { const p = this.pending; this.pending = null; this.detect(p); }
    },
    status(t) { const el = $('#locStatus'); if (el) el.textContent = t; },
    icon(kind, isDay) {
      const sun = '<g class="wx-sun"><circle cx="30" cy="16" r="6"/><path d="M30 5v3M30 24v3M19 16h3M38 16h3M22.2 8.2l2.1 2.1M35.7 21.7l2.1 2.1M37.8 8.2l-2.1 2.1"/></g>';
      const moon = '<path class="wx-moon" d="M34 6a10 10 0 1 0 8 15A8 8 0 0 1 34 6z"/>';
      const sky = isDay ? sun : moon;
      const cloud = (dark) => `<path class="wx-cloud${dark ? ' dark' : ''}" d="M12 38h22a7 7 0 0 0 .6-14 10 10 0 0 0-19.2 2.6A5.8 5.8 0 0 0 12 38z"/>`;
      if (kind === 'clear') return isDay ? '<g class="wx-sun" transform="translate(-6 8)"><circle cx="30" cy="16" r="8"/><path d="M30 3v4M30 25v4M17 16h4M39 16h4M20.8 6.8l2.8 2.8M36.4 22.4l2.8 2.8M39.2 6.8l-2.8 2.8M23.6 22.4l-2.8 2.8"/></g>' : '<path class="wx-moon" d="M28 6a14 14 0 1 0 12 21A11 11 0 0 1 28 6z"/>';
      if (kind === 'partly') return sky + cloud(false);
      if (kind === 'fog') return cloud(true) + '<path class="wx-fog" d="M8 42h28M14 46h26"/>';
      if (kind === 'rain') return cloud(true).replace('38h22', '32h22').replace('0 0 12 38', '0 0 12 32') + '<path class="wx-rain" d="M16 37l-2 6M24 37l-2 6M32 37l-2 6"/>';
      if (kind === 'storm') return cloud(true) + '<path class="wx-bolt" d="M24 30l-5 9h5l-3 8 9-11h-5l3-6z"/>';
      return cloud(true);
    },
    render() {
      const l = this.loc;
      if (l) {
        $('#locCity').textContent = this.label();
        $('#locCoords').textContent = `${l.lat.toFixed(4)}, ${l.lon.toFixed(4)}`;
        const src = $('#locSource');
        src.textContent = SOURCE_LABEL[l.source];
        src.classList.toggle('live', l.source === 'gps' || l.source === 'ip' || l.source === 'manual');
      }
      const w = this.wx;
      if (w) {
        const [desc, kind] = WMO[w.code] || ['—', 'cloud'];
        $('#weatherTemp').textContent = Math.round(w.temp);
        $('#weatherDesc').textContent = desc + (w.simulated ? ' (simulado)' : '');
        $('#weatherMeta').textContent = `UMID ${Math.round(w.hum)}% · ${Math.round(w.wind)} km/h · ${w.live ? 'AO VIVO' : w.simulated ? 'OFFLINE' : 'CACHE'}`;
        $('#wxIcon').innerHTML = this.icon(kind, w.isDay);
      }
    },
    init() {
      const saved = Store.get('loc', null);
      this.loc = saved ? { ...saved, source: 'saved' } : { name: 'Ivinhema', uf: 'MS', cc: 'BR', lat: -22.30127, lon: -53.82866, source: 'default' };
      Geo.cities.home = [this.loc.lon, this.loc.lat];
      this.render();
      $('#locRefresh').addEventListener('click', () => this.detect({ notify: true }));
      $('#locDetect').addEventListener('click', () => this.detect({ notify: true }));
      Bus.on('settings', ({ key }) => { if (key === 'locMode' || key === 'location' || key === '*') this.detect({ notify: true }); });
      this.detect();
      setInterval(() => this.weather(), 15 * 60000);
    },
  };

  /* ======================================================================
     API — comunicação com o backend Python (mesma origem: http://127.0.0.1:8000)
     Respostas no formato {success, data} / {success:false, error:{code,message}}.
     ====================================================================== */
  class ApiError extends Error {
    constructor(code, message, status = 0) { super(message); this.code = code; this.status = status; }
  }
  const Api = {
    usable: location.protocol === 'http:' || location.protocol === 'https:',
    async req(method, path, body) {
      if (window.JarvisWebCore) {   // versão web: o núcleo roda nesta página (webcore.js)
        try { return await window.JarvisWebCore.request(method, path, body ?? (method === 'GET' ? undefined : {})); }
        catch (e) { throw new ApiError(e.code || 'ERROR', e.message || 'Erro', e.status || 0); }
      }
      if (!this.usable) throw new ApiError('NO_BACKEND', 'A interface foi aberta como arquivo. Rode "python main.py" e acesse http://127.0.0.1:8000.');
      const opts = { method, headers: {} };
      if (method !== 'GET') {
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['X-JARVIS-Client'] = 'interface';   // exigido pelo backend em POST/PATCH/DELETE
        opts.body = JSON.stringify(body ?? {});
      }
      let res;
      try { res = await fetch(path, opts); } catch {
        Backend.markOffline();
        throw new ApiError('BACKEND_OFFLINE', 'Não consegui falar com o núcleo do JARVIS. O backend está rodando? (python main.py)');
      }
      let data;
      try { data = await res.json(); } catch { throw new ApiError('BAD_RESPONSE', `O servidor respondeu ${res.status} sem JSON — o backend do JARVIS está rodando neste endereço?`, res.status); }
      if (!data || data.success !== true) {
        throw new ApiError(data?.error?.code || 'ERROR', data?.error?.message || 'Erro desconhecido', res.status);
      }
      return data.data;
    },
    /** POST com resposta em Server-Sent Events: chama onEvent({event, ...}) a cada evento. */
    async stream(path, body, onEvent, signal) {
      if (window.JarvisWebCore) {
        if (window.JarvisWebCore.stream) return window.JarvisWebCore.stream(path, body, onEvent, signal);
        const d = await this.post(path.replace(/\/stream$/, ''), body);
        onEvent({ event: 'done', ...d });
        return;
      }
      if (!this.usable) throw new ApiError('NO_BACKEND', 'A interface foi aberta como arquivo. Rode "python main.py" e acesse http://127.0.0.1:8000.');
      let res;
      try {
        res = await fetch(path, { method: 'POST', signal, body: JSON.stringify(body ?? {}),
          headers: { 'Content-Type': 'application/json', 'X-JARVIS-Client': 'interface', Accept: 'text/event-stream' } });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        Backend.markOffline();
        throw new ApiError('BACKEND_OFFLINE', 'Não consegui falar com o núcleo do JARVIS. O backend está rodando? (python main.py)');
      }
      if (!res.ok || !res.body) {
        let data = null;
        try { data = await res.json(); } catch { /* sem JSON */ }
        throw new ApiError(data?.error?.code || 'ERROR', data?.error?.message || `O servidor respondeu ${res.status}.`, res.status);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }
          onEvent(ev);
        }
      }
    },
    get(p) { return this.req('GET', p); },
    post(p, b) { return this.req('POST', p, b); },
    patch(p, b) { return this.req('PATCH', p, b); },
    del(p) { return this.req('DELETE', p); },
  };

  /* ======================================================================
     BACKEND — estado REAL do núcleo (polling de /api/status + eventos ao vivo via SSE)
     ====================================================================== */
  const EVENT_TEXT = {
    JARVIS_READY: ['Núcleo online', 'ok'], MESSAGE_RECEIVED: ['Mensagem recebida', ''], AI_RESPONSE: ['Resposta enviada', ''],
    AI_ERROR: ['Erro do modelo', 'warn'], MEMORY_UPDATED: ['Memória atualizada', 'ok'], TOOL_STARTED: ['Ferramenta iniciada', 'acc'],
    TOOL_FINISHED: ['Ferramenta concluída', 'ok'], CONFIRMATION_REQUIRED: ['Confirmação solicitada', 'warn'],
    PROJECT_UPDATED: ['Projeto atualizado', 'ok'], DEVICE_CONNECTED: ['Dispositivo conectado', 'ok'],
    DEVICE_DISCONNECTED: ['Dispositivo desconectado', 'warn'], MODEL_STATUS: ['Status do modelo mudou', 'acc'],
    SEARCH_STARTED: ['Pesquisa iniciada', 'acc'], SEARCH_FINISHED: ['Pesquisa concluída', 'ok'], STEP_STARTED: ['Etapa do plano', 'acc'],
    GENERATION_CANCELLED: ['Resposta interrompida', 'warn'], METRICS: ['Métricas registradas', ''],
  };
  const Backend = {
    online: false, status: null, es: null, firstContact: true, lastModelOk: null,
    baseState() {
      if (!this.online) return 'offline';
      return this.status?.model?.available ? 'ready' : 'nomodel';
    },
    settle() { if (Boot.done && !Core.isBusy() && !Voice.out.speaking && !Voice.in.active) Core.set(this.baseState()); },
    async poll(deep = false) {
      try {
        const s = await Api.get(`/api/status${deep ? '?deep=true' : ''}`);
        this.setOnline(s);
        return s;
      } catch (e) {
        if (e.code !== 'BACKEND_OFFLINE') this.markOffline();
        return null;
      }
    },
    setOnline(s) {
      const was = this.online;
      this.online = true;
      this.status = s;
      if (!was) {
        this.connectEvents();
        Bus.emit('backend', { online: true });
        if (!this.firstContact) Notify.push({ type: 'ok', title: 'Núcleo reconectado', sub: 'Backend do JARVIS online', target: 'sistema' });
      }
      const m = s.model;
      if (this.lastModelOk !== m.available) {
        if (!m.available) Notify.push({ type: 'warn', title: 'Modelo de IA indisponível', sub: m.error || 'Configure o .env', target: 'sistema' }, { toast: !this.firstContact });
        else if (this.lastModelOk === false) Notify.push({ type: 'ok', title: 'Modelo de IA disponível', sub: `${m.provider} · ${m.name}`, target: 'conversa' });
        this.lastModelOk = m.available;
      }
      if (s.version) $('#sysVersion').textContent = `v${s.version.split('.').slice(0, 2).join('.')}`;
      this.firstContact = false;
      this.settle();
      Chat.showEngine();
    },
    markOffline() {
      if (this.online) Notify.push({ type: 'bad', title: 'Núcleo desconectado', sub: 'O backend parou de responder', target: 'sistema' });
      const was = this.online;
      this.online = false;
      this.status = null;
      if (this.es) { this.es.close(); this.es = null; }
      this.firstContact = false;
      if (was) Bus.emit('backend', { online: false });
      this.settle();
      Chat.showEngine();
    },
    connectEvents() {
      if (window.JarvisWebCore && !this.es) {
        const off = window.JarvisWebCore.subscribe((ev) => this.handle(ev));
        this.es = { close: off };
        return;
      }
      if (this.es || !window.EventSource) return;
      this.es = new EventSource('/api/events/stream');
      this.es.onmessage = (msg) => {
        let ev;
        try { ev = JSON.parse(msg.data); } catch { return; }
        this.handle(ev);
      };
    },
    handle(ev) {
      const t = ev.type;
      if (t === 'STATE_CHANGED' && !Chat.busy) Core.phase(ev.payload?.phase);   // durante o streaming, o próprio stream manda o estado
      if (t === 'METRICS') Chat.showMetrics(ev.payload || {});
      if (t === 'MEMORY_UPDATED') { Memory.load(); if (ev.payload?.source === 'chat') Notify.push({ type: 'ok', title: 'Memória atualizada', sub: 'Novo registro salvo pelo JARVIS', target: 'memoria' }, { toast: false }); }
      if (t === 'PROJECT_UPDATED') Projects.load();
      if (t === 'MODEL_STATUS' || t === 'JARVIS_READY') { this.poll(); Voice.out.probe(); }
      if (t === 'DEVICE_CONNECTED' || t === 'DEVICE_DISCONNECTED') Devices.load();
      System.logEvent(ev);
      HomeUI.pushEvent(ev);
    },
    init() {
      this.poll();
      setInterval(() => this.poll(), 5000);
    },
  };

  /* ======================================================================
     ROUTER — navegação entre seções sem recarregar a página
     ====================================================================== */
  const Router = {
    pages: ['inicio', 'conversa', 'projetos', 'memoria', 'visao', 'dispositivos', 'sistema', 'configuracoes'],
    titles: { inicio: 'Início', conversa: 'Conversa', projetos: 'Projetos', memoria: 'Memória', visao: 'Visão', dispositivos: 'Dispositivos', sistema: 'Sistema', configuracoes: 'Configurações' },
    current: null,
    hooks: {},
    on(page, hooks) { this.hooks[page] = hooks; },
    go(page, { silent = false } = {}) {
      if (!this.pages.includes(page) || page === this.current) return;
      const prev = this.current;
      const prevEl = prev && $(`.page[data-page="${prev}"]`);
      const nextEl = $(`.page[data-page="${page}"]`);
      if (prevEl) {
        prevEl.classList.remove('active');
        prevEl.classList.add('leaving');
        setTimeout(() => prevEl.classList.remove('leaving'), 450);
        this.hooks[prev]?.leave?.();
      }
      nextEl.classList.add('active');
      nextEl.scrollTop = 0;
      this.current = page;
      $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === page));
      this.moveIndicator();
      try { history.replaceState(null, '', '#' + page); } catch { /* file:// em alguns navegadores */ }
      document.title = `JARVIS · ${this.titles[page]}`;
      if (!silent) Sound.play('nav');
      this.hooks[page]?.enter?.();
      Bus.emit('route', page);
    },
    moveIndicator() {
      const btn = $(`.nav-item[data-nav="${this.current}"]`);
      const ind = $('#railIndicator');
      if (!btn) return;
      if (window.matchMedia('(max-width: 760px)').matches) {
        ind.style.left = btn.offsetLeft + 'px';
        ind.style.width = btn.offsetWidth + 'px';
        btn.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      } else {
        ind.style.left = '0px';
        ind.style.width = '3px';
        ind.style.top = btn.offsetTop + 'px';
        ind.style.height = btn.offsetHeight + 'px';
      }
    },
    init() {
      document.addEventListener('click', (e) => {
        const t = e.target.closest('[data-nav]');
        if (t) { e.preventDefault(); this.go(t.dataset.nav); }
      });
      window.addEventListener('resize', () => this.moveIndicator());
      const start = location.hash.slice(1);
      this.go(this.pages.includes(start) ? start : 'inicio', { silent: true });
    },
  };

  /* ======================================================================
     TOAST — avisos curtos e discretos no canto
     ====================================================================== */
  const TYPES = {
    info: { icon: 'info', color: '' },
    msg:  { icon: 'chat', color: '' },
    ok:   { icon: 'check', color: 'var(--ok)' },
    warn: { icon: 'alert', color: 'var(--warn)' },
    bad:  { icon: 'alert', color: 'var(--bad)' },
    sys:  { icon: 'cloud-dl', color: 'var(--orange)' },
    dev:  { icon: 'devices', color: '' },
  };
  const Toast = {
    show(n, dur = 4200) {
      const T = TYPES[n.type] || TYPES.info;
      const el = document.createElement('div');
      el.className = 'toast';
      if (T.color) el.style.setProperty('--nc', T.color);
      el.style.setProperty('--dur', dur + 'ms');
      el.innerHTML = `<span class="n-ico">${icon(T.icon)}</span><div><div class="n-title">${esc(n.title)}</div><div class="n-sub">${esc(n.sub || '')}</div></div><i class="toast-bar"></i>`;
      const box = $('#toasts');
      box.appendChild(el);
      while (box.children.length > 3) box.firstElementChild.remove();
      const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 350); };
      el.addEventListener('click', () => { if (n.target) Router.go(n.target); close(); });
      setTimeout(close, dur);
    },
  };

  /* ======================================================================
     NOTIFY — central de notificações (gaveta própria + badge)
     ====================================================================== */
  const Notify = {
    items: [],
    seq: 0,
    push(n, { toast = true, sound = true } = {}) {
      const item = { id: ++this.seq, read: false, ts: Date.now(), ...n };
      this.items.unshift(item);
      if (this.items.length > 30) this.items.pop();
      this.render();
      if (toast) Toast.show(item);
      if (sound) Sound.play('notify');
      return item;
    },
    remove(id) {
      const li = $(`.notif[data-id="${id}"]`);
      const done = () => { this.items = this.items.filter((i) => i.id !== id); this.render(); };
      if (li) { li.classList.add('removing'); setTimeout(done, 280); } else done();
    },
    render() {
      const list = $('#notifList');
      if (!this.items.length) {
        list.innerHTML = '<li class="notif-empty">Nenhuma notificação.<br><span class="mono">Todos os sistemas em silêncio.</span></li>';
      } else {
        list.innerHTML = this.items.map((n) => {
          const T = TYPES[n.type] || TYPES.info;
          return `<li class="notif ${n.read ? '' : 'unread'}" data-id="${n.id}" ${T.color ? `style="--nc:${T.color}"` : ''}>
            <span class="n-ico">${icon(T.icon)}</span>
            <div><div class="n-title">${esc(n.title)}</div><div class="n-sub">${esc(n.sub || '')}</div></div>
            <span class="n-time">${relTime(n.ts)}</span>
            <button class="n-x" type="button" aria-label="Descartar">${icon('x')}</button>
          </li>`;
        }).join('');
      }
      HomeUI.notifs();
      const unread = this.items.filter((i) => !i.read).length;
      const badge = $('#notifBadge');
      badge.hidden = unread === 0;
      badge.textContent = unread > 9 ? '9+' : unread;
    },
    open() {
      $('#notifDrawer').classList.add('open');
      $('#notifDrawer').setAttribute('aria-hidden', 'false');
      $('#scrim').classList.add('on');
      this.render();
      setTimeout(() => { this.items.forEach((i) => { i.read = true; }); this.render(); }, 1600);
    },
    close() {
      $('#notifDrawer').classList.remove('open');
      $('#notifDrawer').setAttribute('aria-hidden', 'true');
      $('#scrim').classList.remove('on');
    },
    toggle() { $('#notifDrawer').classList.contains('open') ? this.close() : this.open(); },
    init() {
      $('#btnNotif').addEventListener('click', () => this.toggle());
      $('#notifClose').addEventListener('click', () => this.close());
      $('#scrim').addEventListener('click', () => this.close());
      $('#notifClear').addEventListener('click', () => {
        $$('.notif').forEach((li, i) => setTimeout(() => li.classList.add('removing'), i * 50));
        setTimeout(() => { this.items = []; this.render(); }, 320 + this.items.length * 50);
      });
      $('#notifList').addEventListener('click', (e) => {
        const li = e.target.closest('.notif');
        if (!li) return;
        const id = Number(li.dataset.id);
        if (e.target.closest('.n-x')) { e.stopPropagation(); this.remove(id); return; }
        const item = this.items.find((i) => i.id === id);
        if (item) { item.read = true; if (item.target) { Router.go(item.target); this.close(); } this.render(); }
      });
      // atualiza tempos relativos
      setInterval(() => { if ($('#notifDrawer').classList.contains('open')) this.render(); }, 30000);
    },
  };

  /* ======================================================================
     MODAL — janela genérica reutilizável
     ====================================================================== */
  const Modal = {
    onClose: null,
    open({ eyebrow = 'DETALHES', title, body, actions = [], onClose = null }) {
      $('#modalEyebrow').textContent = eyebrow;
      $('#modalTitle').textContent = title;
      const b = $('#modalBody');
      b.innerHTML = '';
      if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
      const f = $('#modalFoot');
      f.innerHTML = '';
      actions.forEach((a) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn ${a.cls || ''}`;
        btn.innerHTML = a.label;
        btn.addEventListener('click', () => a.onClick?.());
        f.appendChild(btn);
      });
      this.onClose = onClose;
      $('#modal').classList.add('open');
      $('#modal').setAttribute('aria-hidden', 'false');
      setTimeout(() => $('#modal input, #modal textarea, #modalClose')?.focus(), 60);
    },
    close() {
      if (!$('#modal').classList.contains('open')) return;
      $('#modal').classList.remove('open');
      $('#modal').setAttribute('aria-hidden', 'true');
      this.onClose?.();
      this.onClose = null;
    },
    isOpen() { return $('#modal').classList.contains('open'); },
    init() {
      $('#modalClose').addEventListener('click', () => this.close());
      $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') this.close(); });
    },
  };

  /* ======================================================================
     HOME — ações da tela inicial (comando, escuta simulada, análise, pesquisa)
     ====================================================================== */
  const Home = {
    listen() { Voice.in.toggle(); },
    async analyze() {
      if (Core.isBusy()) return;
      Core.set('thinking');
      const [sys, dev] = await Promise.all([Api.get('/api/system/status').catch(() => null), Api.get('/api/devices').catch(() => null)]);
      Core.set(Backend.baseState());
      const w = Location.wx;
      const [desc] = (w && WMO[w.code]) || ['—'];
      const online = dev ? dev.items.filter((d) => d.status === 'connected').length : null;
      Modal.open({
        eyebrow: 'RELATÓRIO · DADOS REAIS',
        title: 'Análise de ambiente',
        body: `<dl class="kv">
          <div><dt>LOCAL</dt><dd>${esc(Location.label())}</dd></div>
          <div><dt>CLIMA EXTERNO</dt><dd>${w ? `${Math.round(w.temp)}°C · ${esc(desc)}${w.simulated ? ' (simulado)' : ''}` : '—'}</dd></div>
          <div><dt>NÚCLEO</dt><dd>${Backend.online ? 'online' : 'offline'}</dd></div>
          <div><dt>CPU / RAM</dt><dd>${sys ? `${sys.cpu_percent.toFixed(0)}% / ${sys.ram_percent.toFixed(0)}%` : '—'}</dd></div>
          <div><dt>DISPOSITIVOS</dt><dd>${online == null ? '—' : `${online} conectado(s)`}</dd></div>
          <div><dt>CÂMERA</dt><dd>não conectada</dd></div>
          <div><dt>SENSORES DO AMBIENTE</dt><dd>não conectados</dd></div>
        </dl><p class="dim">Luz, ruído e presença exigem sensores físicos — disponíveis futuramente (FASE 8).</p>`,
        actions: [{ label: 'Ver sistema', cls: 'ghost', onClick: () => { Modal.close(); Router.go('sistema'); } }, { label: 'OK', onClick: () => Modal.close() }],
      });
    },
    search() {
      const go = () => {
        const q = $('#searchQ').value.trim();
        if (!q) { $('#searchQ').focus(); Sound.play('error'); return; }
        Modal.close();
        Router.go('conversa');
        setTimeout(() => Chat.send(`Pesquise ${q}`), 350);
      };
      Modal.open({
        eyebrow: 'PESQUISA · FONTES REAIS',
        title: 'Pesquisar na web',
        body: `<label class="field"><span>O que você quer pesquisar?</span><input id="searchQ" maxlength="120" placeholder="Ex.: preço do ESP32-S3"></label>
               <p class="dim">O JARVIS pesquisa em várias fontes ao mesmo tempo (Wikipedia, GitHub e arXiv sem chave; web geral e notícias com chave Tavily ou Brave no .env), ordena pela confiabilidade e mostra as fontes.</p>`,
        actions: [{ label: 'Cancelar', cls: 'ghost', onClick: () => Modal.close() }, { label: `${icon('search')}Pesquisar`, onClick: go }],
      });
      $('#searchQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    },
    more() {
      const opts = [
        ['conversa', 'chat', 'Conversa'], ['visao', 'eye', 'Visão'], ['sistema', 'cpu', 'Sistema'],
        ['@diag', 'pulse', 'Diagnóstico'], ['@notif', 'bell', 'Notificações'], ['configuracoes', 'gear', 'Configurações'],
      ];
      const body = document.createElement('div');
      body.className = 'more-grid';
      body.innerHTML = opts.map(([k, ic, label]) => `<button class="act" type="button" data-opt="${k}"><svg><use href="#i-${ic}"/></svg><span>${label}</span></button>`).join('');
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-opt]');
        if (!b) return;
        Modal.close();
        const k = b.dataset.opt;
        if (k === '@diag') { Router.go('sistema'); setTimeout(() => System.diagnose(), 400); }
        else if (k === '@notif') Notify.open();
        else Router.go(k);
      });
      Modal.open({ eyebrow: 'ATALHOS', title: 'Mais opções', body });
    },
    init() {
      $('#homeCommand').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('#homeInput');
        const text = input.value.trim();
        if (!text) { input.focus(); return; }
        input.value = '';
        Router.go('conversa');
        setTimeout(() => Chat.send(text), 350);
      });
      $('#topMic').addEventListener('click', () => this.listen());
      $('#topWave').addEventListener('click', () => {
        Settings.set('sound', !Settings.v.sound);
        SettingsUI.sync();
        Toast.show({ type: 'info', title: Settings.v.sound ? 'Sons ativados' : 'Sons desativados', sub: 'Interface' }, 1800);
        Sound.play('toggle');
      });
      document.addEventListener('click', (e) => {
        const a = e.target.closest('[data-action]');
        if (!a) return;
        if (a.dataset.action === 'analyze') this.analyze();
        if (a.dataset.action === 'search') this.search();
        if (a.dataset.action === 'more') this.more();
      });
      const on = (v) => { Wave.active = v; Globe.active = v; WorldMap.active = v; };
      Router.on('inicio', { enter: () => on(true), leave: () => on(false) });
    },
  };

  /* ======================================================================
     VOICE — microfone → texto → JARVIS → fala (fase 3)

     ENTRADA (Voice.in): reconhecimento de fala do navegador (Web Speech API).
       · No Chrome/Edge o áudio é processado pelo serviço de fala do navegador
         (vai para os servidores do Google/Microsoft). O usuário é avisado.
       · O microfone só fica ligado quando há indicador aceso (#topMic / #chatMic).
       · Modos: clique (uma frase) · conversa contínua (escuta ~8 s depois da
         resposta) · palavra de ativação "JARVIS" (opcional, desligada por padrão).
       · Interrupção (barge-in): falar durante a resposta para a fala; "pare",
         "cancela"... só param. Eco da própria voz é filtrado por semelhança.
     SAÍDA (Voice.out): fala frase a frase enquanto o texto chega (streaming).
       · Voz neural do servidor (edge-tts, /api/voice/tts) com pré-carregamento
         da próxima frase; se não houver, usa a voz do navegador.
       · Prosódia: pergunta sobe, aviso desce e desacelera, erro fica calmo.
     ====================================================================== */
  const PROSODY = {   // mesmo algoritmo de voice/prosody.py
    STYLES: { casual: [4, 0, 250], question: [2, 6, 350], warning: [-8, -4, 400], error: [-5, -2, 350], excited: [8, 5, 250], list: [0, 0, 300] },
    clean(t) {
      return t.replace(/\[\d+(?:,\s*\d+)*\]/g, '').replace(/https?:\/\/\S+/g, '').replace(/[*#_`]+/g, '')
        .replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
    },
    classify(s) {
      if (/\b(erro|falhou|falha|n[aã]o consegui|indispon[ií]vel|n[aã]o est[aá] (?:conectad|configurad))/i.test(s)) return 'error';
      if (/\b(aten[cç][aã]o|cuidado|aviso|importante|risco|perigo|n[aã]o recomendo|irrevers[ií]vel)\b/i.test(s)) return 'warning';
      if (/\?\s*$/.test(s)) return 'question';
      if (/^(?:\d+[.)]\s|(?:primeiro|segundo|terceiro)\b)/i.test(s)) return 'list';
      if (/(!|\b(excelente|perfeito|incr[ií]vel|[oó]timo|consegui|pronto|funcionou)\b)/i.test(s)) return 'excited';
      return 'casual';
    },
    utter(sentence, baseRate = 0) {
      const text = this.clean(sentence);
      const style = this.classify(text);
      const [rate, pitch, pause] = this.STYLES[style];
      return { text, style, rate: rate + baseRate, pitch, pause };
    },
  };

  const vnorm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const STOP_RX = /^(?:jarvis )?(?:para|pare|parar|chega|silencio|espera|espere|cancela|cancele|esquece|stop|calma)$/;

  const Voice = {
    lastConv: null,
    report(m) { if (Backend.online && (this.lastConv || Chat.conversationId)) Api.post('/api/metrics/client', { conversation_id: this.lastConv || Chat.conversationId, ...m }).catch(() => {}); },
    state(m) { if (Backend.online && !window.JarvisWebCore) Api.post('/api/voice/state', m).catch(() => {}); },

    /* ------------------------------------------------------------ saída */
    out: {
      speaking: false, queue: [], buf: '', playing: false, server: false, audio: null, spoken: '', t0: 0, firstReported: false, ended: false,
      shouldSpeak(viaVoice) { const m = Settings.v.voiceReply; return m === 'always' || (m === 'voice' && viaVoice); },
      async probe() {
        if (window.JarvisWebCore || !Api.usable) { this.server = false; return; }
        try { const s = await Api.get('/api/voice/status'); this.server = !!s.text_to_speech?.available && s.text_to_speech.engine !== 'browser'; } catch { this.server = false; }
      },
      useServer() { return this.server && Settings.v.ttsEngine !== 'browser'; },
      begin() {
        if (!this.speaking) {
          this.speaking = true; this.ended = false; this.spoken = ''; this.t0 = performance.now(); this.firstReported = false;
          Core.set('speaking'); Voice.state({ speaking: true });
          if (Settings.v.bargeIn && Voice.in.supported && Voice.in.allowed && !Voice.in.active && !Voice.in.muted && Voice.in.lastWasVoice) Voice.in.start('barge');
        }
      },
      /** Recebe pedaços do streaming e fala cada frase assim que ela termina. */
      feed(text) {
        this.buf += text;
        let m;
        while ((m = this.buf.match(/[.!?…](?=\s)|\n/))) {     // frase completa = pontuação seguida de espaço, ou quebra de linha
          const cut = m.index + m[0].length;
          const sentence = this.buf.slice(0, cut).trim();
          this.buf = this.buf.slice(cut);
          if (sentence.length > 1) this.enqueue(sentence);
        }
      },
      say(text) { this.enqueue(text); },
      enqueue(sentence) {
        const u = PROSODY.utter(sentence, Number(Settings.v.voiceRate) || 0);
        if (!u.text || !/[a-z0-9]/i.test(vnorm(u.text))) return;
        this.begin();
        if (this.useServer()) u.audio = this.fetchAudio(u);     // pré-carrega enquanto a frase anterior toca
        this.queue.push(u);
        if (!this.playing) this.next();
      },
      async fetchAudio(u) {
        const res = await fetch('/api/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-JARVIS-Client': 'interface' },
          body: JSON.stringify({ text: u.text, rate: u.rate, pitch: u.pitch }) });
        if (!res.ok) throw new Error('tts ' + res.status);
        return URL.createObjectURL(await res.blob());
      },
      /** Terminou o streaming: fala o resto e, no fim, reabre o microfone (conversa contínua). */
      end(spoke) {
        if (this.buf.trim()) { this.enqueue(this.buf.trim()); this.buf = ''; }
        this.ended = true;
        if (!spoke && !this.queue.length && !this.playing) this.finish(false);
        else if (!this.playing && !this.queue.length) this.finish(true);
      },
      async next() {
        const u = this.queue.shift();
        if (!u) { this.playing = false; if (this.ended) this.finish(true); return; }
        this.playing = true;
        this.spoken += ' ' + u.text;
        try {
          if (u.audio) await this.playServer(u);
          else await this.playBrowser(u);
        } catch (e) {
          if (u.audio) { this.server = false; try { await this.playBrowser(u); } catch { /* sem voz */ } }   // servidor falhou → voz do navegador
        }
        if (!this.speaking) return;
        await wait(u.pause * 0.6);
        this.next();
      },
      markFirst() {
        if (this.firstReported) return;
        this.firstReported = true;
        Voice.report({ tts_ms: Math.round(performance.now() - this.t0) });
      },
      playServer(u) {
        return u.audio.then((url) => new Promise((resolve, reject) => {
          const a = new Audio(url);
          this.audio = a;
          a.volume = clamp(Settings.v.volume * 2.2, 0.2, 1);
          a.onplaying = () => this.markFirst();
          a.onended = () => { URL.revokeObjectURL(url); resolve(); };
          a.onerror = () => reject(new Error('audio'));
          a.play().catch(reject);
        }));
      },
      playBrowser(u) {
        return new Promise((resolve) => {
          if (!window.speechSynthesis) { resolve(); return; }
          const s = new SpeechSynthesisUtterance(u.text);
          s.lang = 'pt-BR';
          const v = Voice.out.pickVoice();
          if (v) s.voice = v;
          s.rate = clamp(1 + u.rate / 100, 0.6, 1.6);
          s.pitch = clamp(1 + u.pitch / 40, 0.5, 1.6);
          s.onstart = () => this.markFirst();
          s.onend = s.onerror = () => resolve();
          speechSynthesis.speak(s);
        });
      },
      pickVoice() {
        const all = window.speechSynthesis?.getVoices() || [];
        const pt = all.filter((v) => /^pt(-|_)?BR/i.test(v.lang));
        return pt.find((v) => /antonio|daniel|male|masculin/i.test(v.name)) || pt.find((v) => /google|microsoft/i.test(v.name)) || pt[0] || null;
      },
      finish(spoke) {
        const was = this.speaking;
        this.speaking = false; this.playing = false; this.queue = []; this.buf = '';
        if (was) { Voice.state({ speaking: false }); Voice.in.stopBarge(); }
        Core.phase('IDLE');
        if (spoke && was && Settings.v.continuous && Voice.in.lastWasVoice && !Voice.in.persistent()) Voice.in.follow();   // no modo "sempre ouvindo" ele já está ouvindo
      },
      /** Para de falar na hora (interrupção). */
      stop() {
        if (!this.speaking && !this.queue.length) { this.buf = ''; return; }
        this.queue = []; this.buf = ''; this.ended = true;
        if (this.audio) { this.audio.pause(); this.audio = null; }
        if (window.speechSynthesis) speechSynthesis.cancel();
        this.finish(false);
      },
    },

    /* ------------------------------------------------------------ entrada */
    in: {
      /* Modos (Configurações → Voz → Microfone):
           always → escuta o tempo todo; clicar no microfone MUTA (descarta o que estava sendo dito e
                    para a resposta); clicar de novo volta a ouvir e volta para o chat.   (padrão)
           wake   → escuta o tempo todo, mas só reage quando ouve "JARVIS".
           click  → cada clique ouve uma frase.                                                    */
      supported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
      allowed: true, blocked: false, rec: null, mode: null, active: false, muted: false,
      lastWasVoice: false, followT: null, tSpeechEnd: 0, noticed: false, restarts: [],
      kind() { const m = Settings.v.micMode; return m === 'wake' || m === 'click' ? m : 'always'; },
      persistent() { return this.kind() !== 'click'; },
      ui() {
        const on = this.active && !this.muted;
        ['#topMic', '#chatMic'].forEach((id) => {
          const b = $(id);
          if (!b) return;
          b.classList.toggle('live', on);
          b.classList.toggle('muted', this.muted && this.persistent());
          b.classList.toggle('blocked', this.blocked);
          b.title = this.blocked ? 'Microfone bloqueado — clique para ver como liberar'
            : this.muted && this.persistent() ? 'Microfone MUDO — clique para voltar a ouvir'
            : on ? 'Ouvindo — clique para mutar' : 'Ligar o microfone';
        });
        const ind = $('#micState');
        if (!ind) return;
        const muted = this.muted && this.persistent();
        ind.hidden = !(on || muted || this.blocked);
        ind.classList.toggle('mute', muted || this.blocked);
        ind.textContent = this.blocked ? 'MICROFONE BLOQUEADO'
          : muted ? 'MUDO · clique no microfone para voltar'
          : this.mode === 'wake' ? 'OUVINDO · diga “JARVIS…”'
          : this.mode === 'barge' ? 'OUVINDO · fale para interromper'
          : 'OUVINDO O TEMPO TODO';
      },
      notice() {
        if (this.noticed) return;
        this.noticed = true;
        Toast.show({ type: 'info', title: 'Microfone ligado', sub: 'O reconhecimento de voz é do navegador: no Chrome/Edge o áudio vai para o serviço de fala dele. Clique no microfone para mutar.' }, 6000);
      },
      explainBlocked() {
        Sound.play('error');
        Modal.open({
          eyebrow: 'VOZ · MICROFONE',
          title: 'O microfone está bloqueado',
          body: window.JarvisWebCore
            ? `<p>Nesta versão publicada dentro do claude.ai o navegador não libera o microfone para a página — isso é uma regra do claude.ai, não dá para contornar daqui.</p><p class="dim">Para falar com o JARVIS use a versão local: <b>python main.py</b> e abra <b>http://127.0.0.1:8000</b> no Chrome. Aqui na web a conversa por texto, o streaming e a voz de resposta funcionam.</p>`
            : `<p>O navegador recusou o microfone para este site.</p><p class="dim">Clique no cadeado ao lado do endereço (127.0.0.1:8000) → Microfone → Permitir, e depois clique em “Tentar de novo”. Use o Chrome ou o Edge.</p>`,
          actions: window.JarvisWebCore ? [{ label: 'Entendi', onClick: () => Modal.close() }]
            : [{ label: 'Fechar', cls: 'ghost', onClick: () => Modal.close() }, { label: 'Tentar de novo', onClick: () => { Modal.close(); this.blocked = false; this.allowed = true; this.unmute(); } }],
        });
      },
      /** Clique no botão do microfone. */
      toggle() {
        if (!this.supported) {
          Sound.play('error');
          Toast.show({ type: 'warn', title: 'Voz indisponível neste navegador', sub: 'Use o Chrome ou o Edge para falar com o JARVIS.' }, 5000);
          return;
        }
        if (this.blocked) { this.explainBlocked(); return; }
        if (this.persistent()) {
          if (this.active && !this.muted) this.mute(); else this.unmute();
          return;
        }
        // modo clique: uma frase por clique
        if (this.active && this.mode !== 'barge') { this.lastWasVoice = false; this.stop(); Sound.play('toggle'); return; }
        Voice.out.stop();
        if (Chat.busy) Chat.stop(true);
        this.start('ptt');
      },
      /** Muta: para de ouvir, descarta o que estava sendo dito e para a resposta em andamento. */
      mute() {
        this.muted = true;
        Store.set('micMuted', true);
        this.discard = true;
        Voice.out.stop();
        if (Chat.busy) Chat.stop(true);
        $('#chatInput').placeholder = 'Escreva para o JARVIS… (Enter envia · Shift+Enter quebra linha)';
        this.stop();
        Sound.play('toggle');
        this.ui();
        Toast.show({ type: 'warn', title: 'Microfone mudo', sub: 'Não estou ouvindo. Clique no microfone para voltar.' }, 2200);
      },
      /** Desmuta: volta a ouvir o tempo todo e volta para a conversa. */
      unmute() {
        this.muted = false;
        Store.set('micMuted', false);
        Store.set('micOn', true);
        this.discard = false;
        if (Router.current !== 'conversa') Router.go('conversa');
        this.start(this.kind());
        this.ui();
      },
      setMode() {                     // mudou o modo nas configurações
        this.stop();
        if (this.persistent() && !this.muted && Store.get('micOn', false)) setTimeout(() => this.start(this.kind()), 300);
        this.ui();
      },
      follow() { clearTimeout(this.followT); this.start('follow'); this.followT = setTimeout(() => { if (this.mode === 'follow') this.stop(); }, 8000); },
      stopBarge() { if (this.mode === 'barge') this.stop(); },
      start(mode) {
        if (!this.supported || !this.allowed || this.blocked) return;
        if (this.muted && this.persistent() && mode !== 'ptt') return;
        if (this.rec) {                                   // já está ouvindo
          if (this.mode !== 'always' && this.mode !== 'wake') this.mode = mode;   // modo contínuo não vira "barge"
          this.ui();
          return;
        }
        const R = window.SpeechRecognition || window.webkitSpeechRecognition;
        const rec = new R();
        rec.lang = 'pt-BR';
        rec.interimResults = true;
        rec.continuous = mode !== 'ptt';
        rec.maxAlternatives = 1;
        this.rec = rec; this.mode = mode; this.active = true; this.discard = false;
        const ta = $('#chatInput');
        rec.onspeechend = () => { this.tSpeechEnd = performance.now(); };
        rec.onresult = (e) => {
          if (this.discard || this.muted) return;
          let interim = '', final = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
          }
          if (interim && this.mode !== 'barge' && this.mode !== 'wake') ta.placeholder = `🎙 ${interim}`;
          if (final.trim()) { ta.placeholder = 'Escreva para o JARVIS… (Enter envia · Shift+Enter quebra linha)'; this.heard(final.trim()); }
        };
        rec.onerror = (e) => {
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
            this.allowed = false; this.blocked = true; this.mode = null;
            this.ui();
            this.explainBlocked();
          } else if (e.error === 'network') {
            Toast.show({ type: 'warn', title: 'Reconhecimento de voz sem conexão', sub: 'O serviço de fala do navegador precisa de internet.' }, 4000);
          }
        };
        rec.onend = () => {
          this.rec = null;
          const keep = this.allowed && !this.blocked && !(this.muted && this.persistent())
            && (this.mode === 'always' || this.mode === 'wake' || this.mode === 'follow' || (this.mode === 'barge' && Voice.out.speaking));
          if (keep) {
            const now = Date.now();
            this.restarts = this.restarts.filter((t) => now - t < 10000).concat(now);
            if (this.restarts.length > 8) {             // reiniciando em loop: algo está errado, para de tentar
              this.mode = null; this.active = false; this.ui();
              Toast.show({ type: 'warn', title: 'Microfone parou', sub: 'O reconhecimento de voz caiu várias vezes. Clique no microfone para tentar de novo.' }, 5000);
              return;
            }
            const m = this.mode;
            setTimeout(() => { if (!this.rec && !(this.muted && this.persistent())) this.start(m); }, 250);
            return;
          }
          if (this.mode === 'barge' && this.persistent() && !this.muted && Store.get('micOn', false)) { this.mode = null; setTimeout(() => this.start(this.kind()), 250); }
          this.active = false; this.mode = null;
          ta.placeholder = 'Escreva para o JARVIS… (Enter envia · Shift+Enter quebra linha)';
          this.ui(); Voice.state({ listening: false }); Core.phase('IDLE');
        };
        try { rec.start(); } catch { this.rec = null; this.active = false; return; }
        if (mode !== 'barge') { this.notice(); if (mode === 'ptt' || mode === 'follow') Sound.play('toggle'); if (!Chat.busy && !Voice.out.speaking) Core.set('listening'); }
        Voice.state({ listening: true });
        this.ui();
      },
      stop() {
        clearTimeout(this.followT);
        this.mode = null;
        if (this.rec) { try { this.rec.abort ? this.rec.abort() : this.rec.stop(); } catch { /* já parado */ } }
        else { this.active = false; this.ui(); }
      },
      /** Frase final reconhecida. */
      heard(raw) {
        const n = vnorm(raw);
        if (!n || n.length < 2 || this.muted) return;
        if (this.tSpeechEnd) { Voice.report({ stt_ms: Math.round(performance.now() - this.tSpeechEnd) }); this.tSpeechEnd = 0; }
        const clean = raw.replace(/^\s*(?:ok[,\s]+)?jarvis[,!.\s]*/i, '').trim();
        if (Voice.out.speaking) {                          // falando por cima do JARVIS
          if (STOP_RX.test(n)) { Voice.out.stop(); Chat.stop(true); return; }
          const spoken = vnorm(Voice.out.spoken);
          const words = n.split(' ');
          const echo = words.filter((w) => spoken.includes(w)).length / words.length;
          if (echo > 0.6 || (words.length < 3 && !/\bjarvis\b/.test(n))) return;   // provavelmente o eco da própria voz
          if (this.mode === 'wake' && !/\bjarvis\b/.test(n)) return;
          Voice.out.stop();
          this.lastWasVoice = true;
          Chat.send(clean || raw, { voice: true });
          return;
        }
        if (this.mode === 'wake') {
          const m = raw.match(/\bjarvis\b[,!.\s]*(.*)$/i);
          if (!m) return;                                   // sem a palavra de ativação: ignora
          if (!m[1].trim()) { Sound.play('toggle'); Toast.show({ type: 'info', title: 'Pois não?', sub: 'Pode falar.' }, 1500); this.wakeOpen = Date.now(); return; }
          raw = m[1];
        } else if (this.mode === 'always' && this.wakeOpen) this.wakeOpen = 0;
        if (this.mode === 'follow') clearTimeout(this.followT);
        this.lastWasVoice = true;
        if (Router.current !== 'conversa') Router.go('conversa');
        if (this.mode === 'ptt' || this.mode === 'follow') this.stop();
        if (STOP_RX.test(n)) { Voice.out.stop(); Chat.stop(); return; }
        Chat.send(this.mode === 'wake' ? raw : (clean || raw), { voice: true });
      },
    },
    init() {
      if (window.speechSynthesis) speechSynthesis.getVoices();   // carrega a lista de vozes
      if (Settings.v.wakeWord && !Store.get('settings', {}).micMode) Settings.v.micMode = 'wake';   // configuração antiga
      this.in.muted = Store.get('micMuted', false);
      this.out.probe();
      Bus.on('backend', () => this.out.probe());
      this.in.ui();
      // Microfone "sempre ouvindo": religa sozinho se você já tinha ligado antes e não deixou mudo
      if (this.in.persistent() && Store.get('micOn', false) && !this.in.muted) setTimeout(() => this.in.start(this.in.kind()), 1500);
      Bus.on('settings', ({ key }) => { if (key === 'micMode') this.in.setMode(); });
    },
  };

  /* ======================================================================
     CHAT — conversa real com o núcleo (streaming: POST /api/chat/stream)
     ====================================================================== */
  const Chat = {
    conversationId: null,
    busy: false,
    times: [],
    count: 0,
    el(role, text, { time = hhmm(), tag = '', animate = true, cls = '' } = {}) {
      const div = document.createElement('div');
      div.className = `msg ${role} ${cls}`.trim();
      if (!animate) div.style.animation = 'none';
      if (role === 'system') {
        div.textContent = text;
      } else {
        div.innerHTML = `<div class="msg-meta"><span class="msg-who">${role === 'jarvis' ? 'JARVIS' : 'USER'}</span>${tag ? `<span class="msg-route">${esc(tag)}</span>` : ''}<span class="msg-time">${time}</span></div><div class="msg-text"></div>`;
        $('.msg-text', div).textContent = text;
      }
      $('#chatLog').appendChild(div);
      this.scroll();
      return div;
    },
    scroll() { const log = $('#chatLog'); log.scrollTop = log.scrollHeight; },
    routeTag(route) {
      if (!route) return '';
      if (route.tool) return route.tool;
      return { llm: 'IA', confirm: 'confirmação', cancelled: 'cancelado', error: 'erro', command: 'comando', plan: 'plano' }[route.type] || '';
    },
    stats() {
      $('#chatCount').textContent = this.count;
      $('#chatAvg').textContent = this.times.length ? (this.times.reduce((a, b) => a + b, 0) / this.times.length / 1000).toFixed(2) + 's' : '—';
      const chars = $$('#chatLog .msg-text').reduce((a, el) => a + el.textContent.length, 0);
      $('#chatCtx').textContent = Math.round(chars / 4) + ' tok';
    },
    /** Observabilidade: tempos reais da última resposta (modelo, pesquisa, total). */
    showMetrics(m) {
      const el = $('#chatLat');
      if (!el) return;
      const f = (v) => (v == null ? null : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
      const parts = [m.llm_first_ms != null && `1ª palavra ${f(m.llm_first_ms)}`, m.search_ms != null && `busca ${f(m.search_ms)}`, m.total_ms != null && `total ${f(m.total_ms)}`].filter(Boolean);
      el.textContent = parts.join(' · ') || '—';
      el.title = JSON.stringify(m);
    },
    showEngine() {
      const tag = $('#chatModel'), eng = $('#chatEngine');
      if (!Backend.online) { tag.className = 'tag bad'; tag.textContent = 'NÚCLEO OFFLINE'; eng.textContent = '—'; return; }
      const m = Backend.status.model;
      tag.className = m.available ? 'tag ok' : 'tag warn';
      tag.textContent = m.available ? `IA: ${m.provider.toUpperCase()}` : 'SEM MODELO DE IA';
      eng.textContent = m.available ? (m.name || m.provider) : 'indisponível';
    },
    async type(div, text) {
      const out = $('.msg-text', div);
      if (!Settings.v.animations) { out.textContent = text; return; }
      const caret = document.createElement('span');
      caret.className = 'caret';
      const step = Math.max(1, Math.ceil(text.length / 120));
      for (let i = 0; i <= text.length; i += step) {
        out.textContent = text.slice(0, i);
        out.appendChild(caret);
        this.scroll();
        await wait(16);
      }
      out.textContent = text;
    },
    clientContext() {
      const w = Location.wx;
      const [desc] = (w && WMO[w.code]) || [];
      return {
        user_name: Settings.v.userName,
        model_tier: Settings.v.claudeTier,
        location: Location.loc ? Location.label() : undefined,
        local_time: new Date().toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' }),
        weather: w && !w.simulated ? `${Math.round(w.temp)}°C, ${(desc || '').toLowerCase()}` : undefined,
      };
    },
    confirmButtons(div) {
      const box = document.createElement('div');
      box.className = 'confirm-actions';
      box.innerHTML = '<button class="btn sm" type="button" data-say="sim">Sim, pode</button><button class="btn sm ghost" type="button" data-say="não">Não</button>';
      div.appendChild(box);
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-say]');
        if (!b) return;
        box.remove();
        this.send(b.dataset.say);
      });
    },
    PHASE_TEXT: { THINKING: 'JARVIS PENSANDO', SEARCHING: 'PESQUISANDO FONTES', READING: 'LENDO AS FONTES', PROCESSING: 'PROCESSANDO',
                  EXECUTING: 'EXECUTANDO', WAITING_CONFIRMATION: 'AGUARDANDO CONFIRMAÇÃO' },
    ctl: null,
    setBusy(on) {
      this.busy = on;
      const b = $('.send-btn[type="submit"]');
      b.classList.toggle('stop', on);
      $('span', b).textContent = on ? 'PARAR' : 'ENVIAR';
      $('use', b).setAttribute('href', on ? '#i-stop' : '#i-send');
    },
    /** Interrompe a resposta atual (botão PARAR, Esc, "pare" por voz ou nova pergunta). */
    async stop(silent = false) {
      Voice.out.stop();
      if (!this.busy) return;
      const conv = this.conversationId;
      if (this.ctl) this.ctl.abort();
      if (conv) Api.post('/api/chat/cancel', { conversation_id: conv }).catch(() => {});
      if (!silent) Sound.play('toggle');
    },
    renderSources(div, items, conflicts) {
      if (!div || !items?.length) return;
      let box = $('.msg-sources', div);
      if (!box) { box = document.createElement('div'); box.className = 'msg-sources'; div.appendChild(box); }
      const rows = items.slice(0, 8).map((s, i) => {
        const title = esc(s.title || s.domain || 'fonte');
        const link = /^https?:\/\//i.test(s.url || '') ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : `<span>${title}</span>`;
        const meta = [s.tier_label, s.universe, s.domain, s.published].filter(Boolean).map(esc).join(' · ');
        const notes = (s.notes || []).length ? `<em>${esc(s.notes.join('; '))}</em>` : '';
        return `<li><b>[${i + 1}]</b> ${link}<small>${meta}</small>${notes}</li>`;
      }).join('');
      const warn = conflicts?.length ? `<p class="src-warn">${esc(conflicts.join(' '))}</p>` : '';
      box.innerHTML = `<span class="src-head">FONTES (${items.length})</span><ol>${rows}</ol>${warn}`;
    },
    renderPlan(div, steps, current) {
      if (!div) return;
      let box = $('.msg-plan', div);
      if (!box) { box = document.createElement('div'); box.className = 'msg-plan'; div.insertBefore(box, $('.msg-text', div)); }
      box.innerHTML = `<span class="src-head">PLANO</span><ol>${steps.map((s, i) => `<li class="${i + 1 < current ? 'done' : i + 1 === current ? 'on' : ''}">${esc(s.goal || s.tool)} <small>${esc(s.tool)}</small></li>`).join('')}</ol>`;
    },
    async send(raw, { voice = false } = {}) {
      const text = String(raw || '').trim();
      if (!text) return;
      if (this.busy) {                       // falar/escrever durante a resposta = interromper e mandar a nova
        await this.stop(true);
        for (let i = 0; i < 40 && this.busy; i++) await wait(25);
      }
      Voice.out.stop();
      this.setBusy(true);
      $$('.confirm-actions').forEach((b) => b.remove());
      this.el('user', text, { tag: voice ? 'voz' : '' });
      this.count++;
      Sound.play('send');
      this.stats();
      const think = $('#chatThinking');
      $('span', think).textContent = this.PHASE_TEXT.THINKING;
      think.hidden = false;
      this.scroll();
      const speak = Voice.out.shouldSpeak(voice);
      const t0 = performance.now();
      const ctl = new AbortController();
      this.ctl = ctl;
      const st = { div: null, text: '', steps: [], said: false, done: null };
      const ensure = () => {
        if (!st.div) { think.hidden = true; st.div = this.el('jarvis', '', {}); if (!st.firstMs) st.firstMs = performance.now() - t0; }
        return st.div;
      };
      const out = () => $('.msg-text', ensure());
      const caret = document.createElement('span');
      caret.className = 'caret';
      const onEvent = (ev) => {
        switch (ev.event) {
          case 'start':
            this.conversationId = ev.conversation_id;
            Store.set('conversation', ev.conversation_id);
            break;
          case 'state':
            Core.phase(ev.phase);
            if (this.PHASE_TEXT[ev.phase]) $('span', think).textContent = this.PHASE_TEXT[ev.phase];
            if (ev.phase === 'SEARCHING' && speak && !st.said) { st.said = true; Voice.out.say('Vou verificar.'); }
            break;
          case 'delta':
            st.text += ev.text;
            out().textContent = st.text;
            out().appendChild(caret);
            if (speak) Voice.out.feed(ev.text);
            this.scroll();
            break;
          case 'sources': this.renderSources(ensure(), ev.items, ev.conflicts); this.scroll(); break;
          case 'plan': st.steps = ev.steps; this.renderPlan(ensure(), st.steps, 0); break;
          case 'step': this.renderPlan(ensure(), st.steps, ev.index); $('span', think).textContent = `ETAPA ${ev.index}/${ev.total}`; break;
          case 'tool': if (ev.status === 'started') $('span', think).textContent = `FERRAMENTA: ${String(ev.tool).toUpperCase()}`; break;
          case 'done': st.done = ev; break;
          default: break;
        }
      };
      let errMsg = null, errCode = '';
      try {
        await Api.stream('/api/chat/stream', { message: text, conversation_id: this.conversationId, client: { ...this.clientContext(), voice } }, onEvent, ctl.signal);
      } catch (e) {
        if (e.name !== 'AbortError') {
          errMsg = e.message; errCode = e.code;
          if (e.code !== 'BACKEND_OFFLINE' && e.code !== 'NO_BACKEND') Backend.poll();
        }
      }
      this.ctl = null;
      think.hidden = true;
      const d = st.done;
      const div = ensure();
      const txt = $('.msg-text', div);
      if (d) {
        this.conversationId = d.conversation_id;
        Store.set('conversation', d.conversation_id);
        const isErr = d.route?.type === 'error';
        if (!st.text && d.reply) {                     // resposta veio inteira (ferramenta sem modelo, comando...)
          await this.type(div, d.reply);
          if (speak && !isErr) Voice.out.feed(d.reply);
        } else txt.textContent = d.reply || st.text;
        if (d.sources?.length && !$('.msg-sources', div)) this.renderSources(div, d.sources, []);
        const tag = this.routeTag(d.route);
        if (tag) $('.msg-meta', div).insertBefore(Object.assign(document.createElement('span'), { className: 'msg-route', textContent: tag }), $('.msg-time', div));
        if (isErr) { div.classList.add('error'); Sound.play('error'); } else Sound.play('receive');
        if (d.pending_confirmation) this.confirmButtons(div);
        Voice.out.end(speak && !isErr && d.route?.type !== 'command');
        if (d.metrics) Voice.lastConv = d.conversation_id;
      } else if (errMsg) {
        txt.textContent = errMsg;
        div.classList.add('error');
        $('.msg-meta', div).insertBefore(Object.assign(document.createElement('span'), { className: 'msg-route', textContent: errCode }), $('.msg-time', div));
        Sound.play('error');
        Voice.out.stop();
      } else {                                            // interrompido
        txt.textContent = st.text.trim() || '(interrompido)';
        div.classList.add('cut');
        $('.msg-meta', div).insertBefore(Object.assign(document.createElement('span'), { className: 'msg-route', textContent: 'interrompido' }), $('.msg-time', div));
      }
      this.times.push(st.firstMs || performance.now() - t0);
      this.count++;
      this.stats();
      this.setBusy(false);
      Core.phase(d?.route?.type === 'confirm' ? 'WAITING_CONFIRMATION' : d?.route?.type === 'error' ? 'ERROR' : 'IDLE');
    },
    async loadHistory() {
      $('#chatLog').innerHTML = '';
      this.count = 0;
      if (!Backend.online) {
        this.el('system', window.JarvisWebCore ? '— núcleo web iniciando… —' : Api.usable ? '— núcleo offline: inicie o backend com "python main.py" —' : '— abra a interface pelo servidor: http://127.0.0.1:8000 —');
        this.stats();
        return;
      }
      try {
        const saved = Store.get('conversation', null);
        const d = await Api.get(`/api/chat/history${saved ? `?conversation_id=${saved}` : ''}`).catch(() => Api.get('/api/chat/history'));
        this.conversationId = d.conversation_id;
        if (d.messages.length) {
          this.el('system', '— conversa anterior restaurada —', { animate: false });
          d.messages.forEach((m) => {
            const isErr = m.route === 'error';
            const tag = m.role === 'assistant' ? (m.route?.startsWith('tool:') ? m.route.slice(5) : this.routeTag({ type: m.route })) : '';
            const div = this.el(m.role === 'user' ? 'user' : 'jarvis', m.content, { time: m.created_at ? hhmm(new Date(m.created_at.replace(' ', 'T') + 'Z')) : '', tag, animate: false, cls: isErr ? 'error' : '' });
            if (m.sources?.length) this.renderSources(div, m.sources, []);
          });
          this.count = d.messages.length;
        } else {
          this.welcome();
        }
      } catch (e) {
        this.el('system', `— não foi possível carregar o histórico: ${e.message} —`);
      }
      this.stats();
    },
    welcome() {
      const first = (Settings.v.userName || '').split(' ')[0];
      this.el('jarvis', `Olá, ${first}. Núcleo conectado.${Backend.status?.model?.available ? '' : '\nO modelo de IA ainda não está configurado (.env), mas cálculos, memória, arquivos e status do sistema já funcionam.'}`, { tag: 'sistema' });
    },
    async clear() {
      if (!Backend.online) { Toast.show({ type: 'bad', title: 'Núcleo offline', sub: 'Inicie o backend para começar uma conversa.' }); return; }
      try {
        const d = await Api.post('/api/chat/new');
        this.conversationId = d.conversation_id;
        Store.set('conversation', d.conversation_id);
        $('#chatLog').innerHTML = '';
        this.count = 0; this.times = [];
        this.el('system', `— nova conversa iniciada às ${hhmmss()} —`);
        this.welcome();
        this.stats();
      } catch (e) { Toast.show({ type: 'bad', title: 'Erro', sub: e.message }); }
    },
    autoGrow() {
      const ta = $('#chatInput');
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
    },
    init() {
      const ta = $('#chatInput');
      $('#chatForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const v = ta.value;
        if (this.busy && !v.trim()) { this.stop(); return; }
        ta.value = '';
        this.autoGrow();
        this.send(v);
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); }
      });
      ta.addEventListener('input', () => this.autoGrow());
      $('#chatSuggest').addEventListener('click', (e) => {
        const b = e.target.closest('[data-say]');
        if (b) this.send(b.dataset.say);
      });
      $('#chatClear').addEventListener('click', () => this.clear());
      $('#chatMic').addEventListener('click', () => Voice.in.toggle());
      Bus.on('backend', () => this.loadHistory());
      Router.on('conversa', { enter: () => setTimeout(() => { this.scroll(); if (window.innerWidth > 760) ta.focus(); }, 300) });
      this.loadHistory();
      this.showEngine();
    },
  };

  /* ======================================================================
     PROJECTS — projetos vindos do backend (GET /api/projects)
     Hoje só existe o JARVIS; a lista é dinâmica para receber outros no futuro.
     ====================================================================== */
  const MS_LABEL = { done: 'concluído', in_progress: 'em andamento', pending: 'pendente' };
  const MS_NEXT = { pending: 'in_progress', in_progress: 'done', done: 'pending' };
  const Projects = {
    statusTag: { 'Em desenvolvimento': '', 'Protótipo': 'ok', 'Planejamento': 'warn', 'Pesquisa': '' },
    filter: 'todos',
    items: [],
    loaded: false,
    async load() {
      try {
        const d = await Api.get('/api/projects');
        this.items = d.items;
        this.loaded = true;
      } catch {
        this.items = [];
        this.loaded = false;
      }
      this.render();
    },
    render() {
      const list = this.filter === 'todos' ? this.items : this.items.filter((p) => p.status === this.filter);
      $('#projCount').textContent = this.items.length;
      let html = list.map((p, i) => `<article class="proj frame" tabindex="0" data-slug="${esc(p.slug)}" style="animation-delay:${i * 60}ms">
          <div class="proj-top"><span class="proj-code">${esc(p.code)}</span><span class="tag ${this.statusTag[p.status] || ''}">${esc(p.status.toUpperCase())}</span></div>
          <div><span class="eyebrow">${esc(p.subtitle || '')}</span><h3>${esc(p.name.toUpperCase())}</h3></div>
          <p>${esc(p.description || '')}</p>
          <div class="proj-progress"><div class="proj-bar"><i style="--p:${p.progress}%"></i></div><span class="proj-pct">${p.progress}%</span></div>
          <div class="proj-tags">${p.tags.map((t) => `<span>#${esc(t)}</span>`).join('')}</div>
        </article>`).join('');
      if (!this.loaded) {
        html = `<div class="empty-state frame"><span class="eyebrow">NÚCLEO OFFLINE</span><p>Os projetos ficam no banco do JARVIS. Inicie o backend (<span class="mono">python main.py</span>) para vê-los.</p></div>`;
      } else if (!list.length) {
        html = `<div class="empty-state frame"><span class="eyebrow">FILTRO</span><p>Nenhum projeto com esse status.</p></div>`;
      }
      $('#projGrid').innerHTML = html;
      HomeUI.projects();
    },
    async detail(slug) {
      let p;
      try { p = await Api.get(`/api/projects/${encodeURIComponent(slug)}`); } catch (e) { Toast.show({ type: 'bad', title: 'Projeto indisponível', sub: e.message }); return; }
      const body = document.createElement('div');
      body.style.display = 'grid';
      body.style.gap = '14px';
      const draw = () => {
        body.innerHTML = `
          <p>${esc(p.description || '')}</p>
          <div class="proj-progress"><div class="proj-bar"><i style="--p:${p.progress}%;animation:none"></i></div><span class="proj-pct">${p.progress}%</span></div>
          <div><span class="eyebrow">FASES · clique para mudar o status</span>
            <ul class="milestones">${p.milestones.map((m) => `<li data-id="${m.id}" class="${m.status === 'done' ? 'done' : m.status === 'in_progress' ? 'doing' : ''}"><i></i><span>${esc(m.title)}</span><small class="mono dim">${MS_LABEL[m.status]}</small></li>`).join('')}</ul>
          </div>`;
      };
      draw();
      body.addEventListener('click', async (e) => {
        const li = e.target.closest('.milestones li');
        if (!li) return;
        const m = p.milestones.find((x) => String(x.id) === li.dataset.id);
        try {
          p = await Api.patch(`/api/projects/${encodeURIComponent(slug)}/milestones/${m.id}`, { status: MS_NEXT[m.status] });
          Sound.play('toggle');
          draw();
          this.load();
        } catch (err) { Toast.show({ type: 'bad', title: 'Não foi possível atualizar', sub: err.message }); }
      });
      Modal.open({ eyebrow: `${p.code} · ${p.subtitle || ''} · ${p.tags.map((t) => '#' + t).join(' ')}`, title: p.name.toUpperCase(), body,
        actions: [{ label: 'Fechar', onClick: () => Modal.close() }] });
    },
    init() {
      $('#projGrid').addEventListener('click', (e) => {
        const card = e.target.closest('.proj[data-slug]');
        if (card) this.detail(card.dataset.slug);
      });
      $('#projGrid').addEventListener('keydown', (e) => {
        const card = e.target.closest('.proj[data-slug]');
        if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.detail(card.dataset.slug); }
      });
      $('#projFilter').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        this.filter = b.dataset.filter;
        $$('#projFilter button').forEach((x) => x.classList.toggle('on', x === b));
        this.render();
      });
      $('#projNew').addEventListener('click', () => Toast.show({ type: 'info', title: 'Novos projetos', sub: 'Disponível futuramente. Por enquanto o único projeto ativo é o JARVIS.' }, 3500));
      Bus.on('backend', () => this.load());
      this.load();
    },
  };

  /* ======================================================================
     MEMORY — mapa neural das memórias REAIS (GET /api/memory)
     ====================================================================== */
  const Memory = {
    cats: [
      { id: 'pessoal', name: 'Pessoal', hue: 192, items: [] },
      { id: 'projetos', name: 'Projetos', hue: 160, items: [] },
      { id: 'preferencias', name: 'Preferências', hue: 42, items: [] },
      { id: 'conhecimento', name: 'Conhecimento', hue: 270, items: [] },
      { id: 'conversas', name: 'Conversas', hue: 210, items: [] },
      { id: 'sistema', name: 'Sistema', hue: 330, items: [] },
      { id: 'contexto', name: 'Contexto', hue: 100, items: [] },
    ],
    loaded: false,
    async load() {
      try {
        const d = await Api.get('/api/memory?limit=500');
        this.cats.forEach((c) => { c.items = d.items.filter((m) => m.category === c.id); });
        this.loaded = true;
      } catch {
        this.cats.forEach((c) => { c.items = []; });
        this.loaded = false;
      }
      if (this.selected?.kind === 'leaf' && !this.cats.some((c) => c.items.some((m) => m.id === this.selected.mem.id))) this.selected = null;
      this.build();
      this.renderCats();
      if (!this.selected) this.emptyDetail();
    },
    emptyDetail() {
      const total = this.cats.reduce((a, c) => a + c.items.length, 0);
      $('#memDetail').innerHTML = !this.loaded
        ? '<span class="eyebrow">NÚCLEO OFFLINE</span><p class="dim">As memórias ficam no banco do JARVIS. Inicie o backend para vê-las.</p>'
        : total
          ? '<span class="eyebrow">NÓ SELECIONADO</span><p class="dim">Clique em um nó do mapa para inspecionar.</p>'
          : '<span class="eyebrow">MEMÓRIA VAZIA</span><p class="dim">Diga na conversa algo como “Meu projeto atual é o JARVIS.” ou use “Nova memória”.</p>';
    },
    async add() {
      const body = `
        <label class="field"><span>O que o JARVIS deve lembrar?</span><textarea id="nmContent" rows="3" maxlength="2000" placeholder="Ex.: Eu prefiro respostas curtas."></textarea></label>
        <label class="field"><span>Categoria</span><select id="nmCat">${this.cats.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}</select></label>
        <label class="field"><span>Assunto (opcional — fatos com assunto são atualizados no lugar)</span><input id="nmKey" maxlength="80" placeholder="Ex.: estilo de resposta"></label>`;
      const save = async () => {
        const content = $('#nmContent').value.trim();
        if (!content) { $('#nmContent').focus(); Sound.play('error'); return; }
        try {
          await Api.post('/api/memory', { content, category: $('#nmCat').value, key: $('#nmKey').value.trim() || null });
          Modal.close();
          Toast.show({ type: 'ok', title: 'Memória salva', sub: content.slice(0, 60) });
          this.load();
        } catch (e) { Toast.show({ type: 'bad', title: 'Não foi possível salvar', sub: e.message }); }
      };
      Modal.open({ eyebrow: 'MATRIZ ASSOCIATIVA · NOVO REGISTRO', title: 'Nova memória', body,
        actions: [{ label: 'Cancelar', cls: 'ghost', onClick: () => Modal.close() }, { label: `${icon('plus')}Salvar`, onClick: save }] });
    },
    async remove(mem) {
      Modal.open({ eyebrow: 'CONFIRMAÇÃO', title: 'Apagar memória?', body: `<p>“${esc(mem.content)}”</p><p class="dim">Essa ação não pode ser desfeita.</p>`,
        actions: [{ label: 'Cancelar', cls: 'ghost', onClick: () => Modal.close() }, { label: `${icon('trash')}Apagar`, cls: 'danger', onClick: async () => {
          try { await Api.del(`/api/memory/${mem.id}`); Modal.close(); this.selected = null; this.load(); Toast.show({ type: 'ok', title: 'Memória apagada', sub: '' }, 2000); }
          catch (e) { Toast.show({ type: 'bad', title: 'Erro', sub: e.message }); }
        } }] });
    },
    nodes: [], links: [], pulses: [],
    canvas: null, w: 0, h: 0, t: 0, active: false,
    hover: null, selected: null, focusCat: null, query: '',
    layout() {
      const fit = fitCanvas(this.canvas);
      this.w = fit.w; this.h = fit.h;
      const cx = this.w / 2, cy = this.h / 2;
      const R = Math.min(this.w, this.h) * 0.32;
      const spread = Math.min(this.w, this.h) * 0.13;
      this.nodes.forEach((n) => {
        if (n.kind === 'center') { n.bx = cx; n.by = cy; return; }
        const ci = this.cats.findIndex((c) => c.id === n.cat);
        const ang = (ci / this.cats.length) * Math.PI * 2 - Math.PI / 2;
        const hx = cx + Math.cos(ang) * R * (this.w > this.h ? 1.25 : 1), hy = cy + Math.sin(ang) * R;
        if (n.kind === 'hub') { n.bx = hx; n.by = hy; return; }
        n.bx = hx + Math.cos(n.a) * spread * n.d;
        n.by = hy + Math.sin(n.a) * spread * n.d;
      });
    },
    build() {
      this.nodes = [{ id: 'center', kind: 'center', label: 'JARVIS', info: 'Núcleo de memória', r: 9 }];
      this.links = [];
      this.cats.forEach((c) => {
        const hub = { id: c.id, kind: 'hub', cat: c.id, label: c.name, info: `${c.items.length} registro(s)`, r: 6, hue: c.hue };
        this.nodes.push(hub);
        this.links.push([hub, this.nodes[0]]);
        c.items.forEach((m, i) => {
          const label = m.key ? m.key[0].toUpperCase() + m.key.slice(1) : (m.content.length > 30 ? m.content.slice(0, 28) + '…' : m.content);
          const n = { id: `m${m.id}`, kind: 'leaf', cat: c.id, label, info: m.content, mem: m, r: 3 + m.importance * 1.6, hue: c.hue,
            a: (i / Math.max(1, c.items.length)) * Math.PI * 2 + (m.id % 7) * 0.09, d: 0.6 + ((m.id * 37) % 50) / 100, ph: (m.id % 10) * 0.63 };
          this.nodes.push(n);
          this.links.push([n, hub]);
        });
      });
      $('#memTotal').textContent = this.nodes.length - 1 - this.cats.length;
      this.layout();
    },
    pos(n) {
      const wob = n.kind === 'leaf' ? 4 : n.kind === 'hub' ? 2 : 0;
      n.x = n.bx + Math.sin(this.t * 0.9 + (n.ph || 0)) * wob;
      n.y = n.by + Math.cos(this.t * 0.7 + (n.ph || 0)) * wob;
    },
    visible(n) {
      if (this.focusCat && n.kind !== 'center' && n.cat !== this.focusCat) return false;
      if (this.query && !norm(n.label + ' ' + n.info).includes(this.query)) return false;
      return true;
    },
    frame() {
      requestAnimationFrame(() => this.frame());
      if (!this.active || document.hidden) return;
      const { ctx } = fitCanvas(this.canvas);
      const { w, h } = this;
      this.t += 0.016;
      ctx.clearRect(0, 0, w, h);
      this.nodes.forEach((n) => this.pos(n));
      const hl = this.hover || this.selected;
      const linked = new Set();
      if (hl) this.links.forEach(([a, b]) => { if (a === hl) linked.add(b); if (b === hl) linked.add(a); });

      // ligações
      this.links.forEach(([a, b, cross]) => {
        const on = this.visible(a) && this.visible(b);
        const hot = hl && (a === hl || b === hl);
        ctx.strokeStyle = hot ? Theme.c(0.8, 65) : Theme.c(on ? (cross ? 0.12 : 0.22) : 0.04, 60, cross ? Theme.h : (a.hue ?? Theme.h));
        ctx.lineWidth = hot ? 1.2 : 0.7;
        if (cross) ctx.setLineDash([3, 4]); else ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      });
      ctx.setLineDash([]);

      // pulsos de dados viajando pelas ligações
      if (Math.random() < 0.12) {
        const l = pick(this.links);
        this.pulses.push({ a: l[0], b: l[1], p: 0, s: rand(0.008, 0.02) });
      }
      this.pulses = this.pulses.filter((pl) => (pl.p += pl.s) < 1);
      this.pulses.forEach((pl) => {
        const x = pl.a.x + (pl.b.x - pl.a.x) * pl.p, y = pl.a.y + (pl.b.y - pl.a.y) * pl.p;
        ctx.fillStyle = Theme.c(1 - pl.p, 80);
        ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 6.28); ctx.fill();
      });

      // nós
      ctx.textAlign = 'center';
      this.nodes.forEach((n) => {
        const on = this.visible(n);
        const isHl = n === hl || linked.has(n);
        const hue = n.hue ?? Theme.h;
        const alpha = on ? 1 : 0.15;
        const r = n.r * (isHl ? 1.5 : 1) * (n.kind === 'center' ? 1 + Math.sin(this.t * 3) * 0.12 : 1);
        ctx.shadowBlur = on ? (n.kind === 'leaf' ? 8 : 18) * Settings.v.intensity : 0;
        ctx.shadowColor = `hsla(${hue}, 100%, 60%, .9)`;
        ctx.fillStyle = `hsla(${hue}, ${n.kind === 'center' ? Theme.s : '100%'}, ${n.kind === 'leaf' ? 66 : 72}%, ${alpha})`;
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 6.28); ctx.fill();
        ctx.shadowBlur = 0;
        if (n.kind !== 'leaf') {
          ctx.strokeStyle = `hsla(${hue}, 100%, 65%, ${alpha * 0.4})`;
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 6 + Math.sin(this.t * 2) * 1.5, 0, 6.28); ctx.stroke();
          ctx.font = `600 ${n.kind === 'center' ? 11 : 9.5}px Orbitron, sans-serif`;
          ctx.fillStyle = `hsla(${hue}, 60%, 85%, ${alpha * 0.9})`;
          ctx.fillText(n.label.toUpperCase(), n.x, n.y - r - 12);
        }
        if (n === this.selected) {
          ctx.strokeStyle = Theme.c(0.9, 75);
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 7, this.t * 2, this.t * 2 + 4.5); ctx.stroke();
        }
      });
    },
    nodeAt(x, y) {
      let best = null, bd = 14 * 14;
      this.nodes.forEach((n) => {
        if (!this.visible(n)) return;
        const d = (n.x - x) ** 2 + (n.y - y) ** 2;
        if (d < bd) { bd = d; best = n; }
      });
      return best;
    },
    showDetail(n) {
      const cat = this.cats.find((c) => c.id === n.cat);
      if (n.kind !== 'leaf') {
        $('#memDetail').innerHTML = `<span class="eyebrow">${n.kind === 'hub' ? 'CATEGORIA' : 'NÚCLEO'}</span><h4>${esc(n.label)}</h4>
          <p>${n.kind === 'hub' ? esc(n.info) : `${this.nodes.length - 1 - this.cats.length} memória(s) no total`}</p>`;
        return;
      }
      const m = n.mem;
      const date = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
      $('#memDetail').innerHTML = `<span class="eyebrow">REGISTRO #${m.id}</span>
        <h4>${esc(n.label)}</h4><p>${esc(m.content)}</p>
        <dl class="kv">
          <div><dt>CATEGORIA</dt><dd>${esc(cat ? cat.name : '—')}</dd></div>
          <div><dt>ASSUNTO</dt><dd>${esc(m.key || '—')}</dd></div>
          <div><dt>ORIGEM</dt><dd>${esc(m.source)}</dd></div>
          <div><dt>ATUALIZADO</dt><dd>${date(m.updated_at)}</dd></div>
        </dl>
        <button class="btn danger sm" type="button" id="memDel" style="margin-top:12px">${icon('trash')}Apagar</button>`;
      $('#memDel').addEventListener('click', () => this.remove(m));
    },
    renderCats() {
      $('#memCats').innerHTML = this.cats.map((c) => `<button class="mem-cat ${this.focusCat === c.id ? 'on' : ''}" type="button" data-cat="${c.id}" style="--ch:${c.hue}"><i></i><span>${c.name}</span><em>${c.items.length}</em></button>`).join('');
    },
    init() {
      this.canvas = $('#memCanvas');
      this.renderCats();
      const view = $('.mem-view');
      const tip = $('#memTip');
      this.canvas.addEventListener('pointermove', (e) => {
        const r = this.canvas.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        $('#memCoords').textContent = `x ${Math.round(x)} · y ${Math.round(y)}`;
        this.hover = this.nodeAt(x, y);
        if (this.hover) {
          tip.hidden = false;
          tip.innerHTML = `<b>${esc((this.cats.find((c) => c.id === this.hover.cat)?.name || 'NÚCLEO').toUpperCase())}</b>${esc(this.hover.label)}`;
          tip.style.left = Math.min(x, r.width - 180) + 'px';
          tip.style.top = y + 'px';
          this.canvas.style.cursor = 'pointer';
        } else {
          tip.hidden = true;
          this.canvas.style.cursor = 'crosshair';
        }
      });
      this.canvas.addEventListener('pointerleave', () => { this.hover = null; tip.hidden = true; });
      this.canvas.addEventListener('click', () => {
        if (!this.hover) return;
        this.selected = this.hover;
        Sound.play('scan');
        this.showDetail(this.selected);
      });
      $('#memCats').addEventListener('click', (e) => {
        const b = e.target.closest('[data-cat]');
        if (!b) return;
        this.focusCat = this.focusCat === b.dataset.cat ? null : b.dataset.cat;
        this.renderCats();
      });
      $('#memSearch').addEventListener('input', (e) => { this.query = norm(e.target.value); });
      new ResizeObserver(() => { if (view.clientWidth) this.layout(); }).observe(view);
      Router.on('memoria', { enter: () => { this.active = true; this.layout(); }, leave: () => { this.active = false; } });
      $('#memAdd').addEventListener('click', () => this.add());
      Bus.on('backend', () => this.load());
      this.load();
      this.frame();
    },
  };

  /* ======================================================================
     VISION — interface de visão. Câmera real: estado vindo do backend (não conectada).
     O botão de simulação mostra dados FICTÍCIOS, sempre rotulados como tal.
     ====================================================================== */
  const Vision = {
    live: false, mode: 'detect', active: false, threshold: 0.6,
    objs: [], fps: 0, frames: 0, lastFps: 0, t: 0, caps: [],
    spawn() {
      const labels = [['PESSOA', 0.22, 0.6], ['MONITOR', 0.2, 0.22], ['CADEIRA', 0.14, 0.3], ['TECLADO', 0.18, 0.07], ['CANECA', 0.05, 0.08], ['CELULAR', 0.05, 0.09], ['LUMINÁRIA', 0.07, 0.2]];
      this.objs = labels.map(([label, w, h], i) => ({
        id: i + 1, label, w, h, x: rand(0.05, 0.95 - w), y: rand(0.15, 0.95 - h),
        vx: rand(-0.0012, 0.0012), vy: rand(-0.0006, 0.0006), conf: rand(0.55, 0.98), trail: [],
      }));
    },
    toggle() {
      this.live = !this.live;
      const btn = $('#visToggle');
      btn.innerHTML = this.live ? `${icon('stop')}<span>Parar simulação</span>` : `${icon('play')}<span>Iniciar simulação</span>`;
      $('#visView').classList.toggle('live', this.live);
      $('#visRec').lastChild.textContent = this.live ? 'SIMULAÇÃO · DADOS FICTÍCIOS' : 'SEM SINAL';
      if (this.live) { this.spawn(); Sound.play('boot'); System.log('Módulo óptico em modo simulação', 'acc'); }
      else { $('#visDetections').innerHTML = '<li class="dim">Nenhum objeto.</li>'; $('#visFps').textContent = '0 FPS'; }
      Bus.emit('vision', this.live);
    },
    drawScene(ctx, w, h) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#02101c'); g.addColorStop(1, '#010509');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // chão em perspectiva
      ctx.strokeStyle = Theme.c(0.12);
      ctx.lineWidth = 1;
      const horizon = h * 0.42;
      for (let i = -12; i <= 12; i++) {
        ctx.beginPath(); ctx.moveTo(w / 2 + i * 12, horizon); ctx.lineTo(w / 2 + i * w * 0.12, h); ctx.stroke();
      }
      for (let i = 0; i < 10; i++) {
        const y = horizon + Math.pow(i / 10, 2) * (h - horizon) + ((this.t * 20) % ((h - horizon) / 10)) * (i / 10);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      // ruído de sensor
      ctx.fillStyle = 'rgba(255,255,255,.035)';
      for (let i = 0; i < 160; i++) ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    },
    frame() {
      requestAnimationFrame(() => this.frame());
      if (!this.active || document.hidden) return;
      const { ctx, w, h } = fitCanvas($('#visCanvas'));
      this.t += 0.016;
      if (!this.live) {
        ctx.fillStyle = '#010407'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = Theme.c(0.05);
        for (let i = 0; i < 500; i++) ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
        return;
      }
      this.drawScene(ctx, w, h);
      ctx.font = '600 10px Orbitron, sans-serif';
      ctx.textBaseline = 'bottom';
      this.objs.forEach((o) => {
        o.x += o.vx; o.y += o.vy;
        if (o.x < 0.02 || o.x + o.w > 0.98) o.vx *= -1;
        if (o.y < 0.08 || o.y + o.h > 0.96) o.vy *= -1;
        o.conf = clamp(o.conf + rand(-0.015, 0.015), 0.35, 0.99);
        const x = o.x * w, y = o.y * h, bw = o.w * w, bh = o.h * h;
        o.trail.push([x + bw / 2, y + bh / 2]);
        if (o.trail.length > 40) o.trail.shift();
        // "objeto" desenhado como silhueta holográfica
        ctx.fillStyle = Theme.c(0.06 + (this.mode === 'depth' ? o.y * 0.25 : 0), 55);
        ctx.fillRect(x, y, bw, bh);
        if (o.conf < this.threshold) return;
        if (this.mode === 'depth') {
          const depth = (1 - o.y).toFixed(2);
          const hue = 200 - o.y * 180;
          ctx.fillStyle = `hsla(${hue}, 100%, 55%, .28)`;
          ctx.fillRect(x, y, bw, bh);
          ctx.fillStyle = `hsla(${hue}, 100%, 75%, 1)`;
          ctx.fillText(`${o.label} · ${(Number(depth) * 4 + 0.5).toFixed(1)}m`, x + 4, y - 4);
          return;
        }
        if (this.mode === 'track') {
          ctx.strokeStyle = Theme.c(0.6, 70);
          ctx.beginPath();
          o.trail.forEach(([tx, ty], i) => (i ? ctx.lineTo(tx, ty) : ctx.moveTo(tx, ty)));
          ctx.stroke();
        }
        // caixa com cantos
        const c = Math.min(14, bw / 4, bh / 4);
        ctx.strokeStyle = Theme.c(0.95, 65);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        [[x, y, 1, 1], [x + bw, y, -1, 1], [x, y + bh, 1, -1], [x + bw, y + bh, -1, -1]].forEach(([px, py, sx, sy]) => {
          ctx.moveTo(px + c * sx, py); ctx.lineTo(px, py); ctx.lineTo(px, py + c * sy);
        });
        ctx.stroke();
        ctx.strokeStyle = Theme.c(0.25); ctx.lineWidth = 1; ctx.strokeRect(x, y, bw, bh);
        const label = this.mode === 'track' ? `#${o.id} ${o.label}` : `${o.label} ${o.conf.toFixed(2)}`;
        const tw = ctx.measureText(label).width + 10;
        ctx.fillStyle = Theme.c(0.85, 55);
        ctx.fillRect(x, y - 16, tw, 15);
        ctx.fillStyle = '#00151c';
        ctx.fillText(label, x + 5, y - 3);
      });
      // FPS
      this.frames++;
      const now = performance.now();
      if (now - this.lastFps > 500) {
        this.fps = Math.round((this.frames * 1000) / (now - this.lastFps));
        this.frames = 0; this.lastFps = now;
        $('#visFps').textContent = `${this.fps} FPS`;
        this.list();
      }
    },
    list() {
      const det = this.objs.filter((o) => o.conf >= this.threshold).sort((a, b) => b.conf - a.conf);
      $('#visDetections').innerHTML = det.length
        ? det.map((o) => `<li><span>${o.label}</span><b>${(o.conf * 100).toFixed(0)}%</b></li>`).join('')
        : '<li class="dim">Nenhum objeto acima do limiar.</li>';
    },
    async refreshStatus() {
      const el = $('#visBackend');
      try {
        const s = await Api.get('/api/vision/status');
        el.innerHTML = `Câmera: <b class="${s.camera === 'connected' ? 'accent' : 'warn-txt'}">${s.camera === 'connected' ? 'CONECTADA' : 'NÃO CONECTADA'}</b> · Modelo: <b>${s.detector.available ? 'ativo' : 'não configurado'}</b>`;
      } catch {
        el.innerHTML = 'Câmera: <b class="warn-txt">NÚCLEO OFFLINE</b>';
      }
    },
    async connectCamera() {
      try {
        await Api.post('/api/vision/start');
        this.refreshStatus();
      } catch (e) {
        Sound.play('error');
        Toast.show({ type: 'warn', title: 'Sinal óptico ausente', sub: e.message }, 4000);
      }
    },
    addCapture(dataUrl) {
      this.caps.unshift(dataUrl);
      this.caps = this.caps.slice(0, 6);
      $('#visCaps').innerHTML = this.caps.map((u, i) => `<img src="${u}" alt="Captura ${i + 1}">`).join('');
    },
    capture() {
      if (!this.live) { Toast.show({ type: 'warn', title: 'Sem sinal', sub: 'Inicie a simulação antes de capturar.' }); Sound.play('error'); return; }
      const src = $('#visCanvas');
      const tmp = document.createElement('canvas');
      tmp.width = 320; tmp.height = 180;
      tmp.getContext('2d').drawImage(src, 0, 0, tmp.width, tmp.height);
      this.addCapture(tmp.toDataURL('image/jpeg', 0.7));
      const f = $('#visFlash');
      f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
      Sound.play('send');
      System.log('Frame capturado pelo módulo óptico', 'ok');
    },
    init() {
      $('#visToggle').addEventListener('click', () => this.toggle());
      $('#visCamera').addEventListener('click', () => this.connectCamera());
      Bus.on('backend', () => this.refreshStatus());
      Router.on('visao', { enter: () => { this.active = true; this.lastFps = performance.now(); this.refreshStatus(); }, leave: () => { this.active = false; } });
      $('#visCapture').addEventListener('click', () => this.capture());
      $('#visMode').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        this.mode = b.dataset.mode;
        $$('#visMode button').forEach((x) => x.classList.toggle('on', x === b));
        $('#visModeLabel').textContent = this.mode.toUpperCase();
      });
      const th = $('#visThresh');
      th.addEventListener('input', () => {
        this.threshold = Number(th.value);
        $('#visThreshVal').textContent = this.threshold.toFixed(2);
        SettingsUI.fill(th);
      });
      const view = $('#visView');
      const ret = $('#visReticle');
      view.addEventListener('pointermove', (e) => {
        const r = view.getBoundingClientRect();
        ret.style.left = `${e.clientX - r.left}px`;
        ret.style.top = `${e.clientY - r.top}px`;
      });
      view.addEventListener('pointerleave', () => { ret.style.left = '50%'; ret.style.top = '50%'; });
      this.frame();
    },
  };

  /* ======================================================================
     DEVICES — dispositivos reais (GET /api/devices). Nada aparece conectado
     sem o driver confirmar; os demais mostram NÃO CONECTADO.
     ====================================================================== */
  const Devices = {
    items: [],
    loaded: false,
    async load() {
      try {
        this.items = (await Api.get('/api/devices')).items;
        this.loaded = true;
      } catch {
        this.items = [];
        this.loaded = false;
      }
      this.render();
    },
    battery(d) { return d.info?.battery ? `${d.info.battery.percent}%` : d.status === 'connected' ? 'AC' : '—'; },
    render() {
      const list = $('#devList');
      if (!this.loaded) {
        list.innerHTML = `<div class="empty-state frame"><span class="eyebrow">NÚCLEO OFFLINE</span><p>Inicie o backend para ver o estado real dos dispositivos.</p></div>`;
      } else {
        list.innerHTML = this.items.map((d, i) => {
          const on = d.status === 'connected';
          const b = d.info?.battery;
          const meta = on ? (d.info.hostname ? `${d.info.hostname} · ${d.info.os}` : d.protocol) : `${d.info?.note || 'integração futura'} · ${d.info?.planned_protocol || d.protocol}`;
          return `<div class="dev ${on ? '' : 'off'}" data-id="${esc(d.id)}" style="animation-delay:${i * 50}ms">
            <span class="dev-ico">${icon(d.icon)}</span>
            <div><div class="dev-name">${esc(d.name)} ${on ? '' : '<span class="tag sm">NÃO CONECTADO</span>'}</div><div class="dev-meta">${esc(d.kind)} · ${esc(meta)} · <span class="${on ? 'accent' : ''}">${on ? 'CONECTADO' : 'NÃO CONECTADO'}</span></div></div>
            <div class="dev-stat sig"><span class="signal" data-level="${on ? 4 : 0}"><i></i><i></i><i></i><i></i></span><small>SINAL</small></div>
            <div class="dev-stat"><span class="batt ${b && b.percent < 40 ? 'low' : ''}"><i style="--b:${b ? b.percent : on ? 100 : 0}%"></i></span>${this.battery(d)}</div>
            <div class="dev-actions">
              ${on ? '<button class="btn sm ghost" type="button" data-act="info">Detalhes</button>' : '<button class="btn sm ghost" type="button" disabled>Disponível futuramente</button>'}
            </div>
          </div>`;
        }).join('');
      }
      HomeUI.devices();
      const on = this.items.filter((d) => d.status === 'connected').length;
      $('#devSummary').textContent = `${on}/${this.items.length}`;
      $('#radarBlips').innerHTML = this.items.map((d, i) => {
        const deg = (i * 137.5 + 20) % 360;
        const a = (deg * Math.PI) / 180;
        const r = 14 + ((i * 17) % 30);
        return `<i class="${d.status === 'connected' ? '' : 'off'}" style="left:${50 + Math.cos(a) * r}%;top:${50 + Math.sin(a) * r}%;animation-delay:${(deg / 360) * 4}s" title="${esc(d.name)}"></i>`;
      }).join('');
    },
    info(id) {
      const d = this.items.find((x) => x.id === id);
      if (!d) return;
      const i = d.info || {};
      Modal.open({
        eyebrow: 'DISPOSITIVO · DADOS REAIS', title: d.name,
        body: `<dl class="kv">
          <div><dt>HOST</dt><dd>${esc(i.hostname || '—')}</dd></div>
          <div><dt>SISTEMA</dt><dd>${esc(i.os || '—')}</dd></div>
          <div><dt>CPU</dt><dd>${i.cpu_percent ?? '—'}%</dd></div>
          <div><dt>RAM</dt><dd>${i.ram_percent ?? '—'}%</dd></div>
          <div><dt>BATERIA</dt><dd>${i.battery ? `${i.battery.percent}%${i.battery.plugged ? ' (na tomada)' : ''}` : 'sem bateria / AC'}</dd></div>
        </dl>`,
        actions: [{ label: 'Fechar', onClick: () => Modal.close() }],
      });
    },
    async scan() {
      const btn = $('#devScan');
      btn.disabled = true;
      $('#radar').classList.add('scanning');
      $('#radarCaption').textContent = 'ATUALIZANDO ESTADO…';
      await this.load();
      await wait(600);
      $('#radar').classList.remove('scanning');
      btn.disabled = false;
      $('#radarCaption').textContent = this.loaded ? 'DESCOBERTA DE REDE: DISPONÍVEL FUTURAMENTE (FASE 8)' : 'NÚCLEO OFFLINE';
    },
    init() {
      $('#devList').addEventListener('click', (e) => {
        const b = e.target.closest('[data-act="info"]');
        if (b) this.info(b.closest('.dev').dataset.id);
      });
      $('#devScan').addEventListener('click', () => this.scan());
      Bus.on('backend', () => this.load());
      setInterval(() => { if (Backend.online && (Router.current === 'dispositivos' || Router.current === 'inicio')) this.load(); }, 15000);
      this.load();
    },
  };

  /* ======================================================================
     SYSTEM — telemetria REAL do computador (GET /api/system/status) + log de eventos
     ====================================================================== */
  const System = {
    metrics: {
      cpu:  { v: 0, max: 100, hist: [] },
      ram:  { v: 0, max: 100, hist: [] },
      net:  { v: 0, max: 10, hist: [] },     // Mb/s — escala se ajusta ao maior valor visto
      core: { v: 0, max: 100, hist: [] },    // CPU do processo do JARVIS
    },
    uptimeBase: null,
    uptimeAt: 0,
    data: null,
    log(text, cls = '') {
      const box = $('#sysLog');
      const div = document.createElement('div');
      div.innerHTML = `<time>${hhmmss()}</time><span class="${cls}">${esc(text)}</span>`;
      box.appendChild(div);
      while (box.children.length > 150) box.firstElementChild.remove();
      box.scrollTop = box.scrollHeight;
    },
    logEvent(ev) {
      if (ev.type === 'AI_THINKING') return;
      const [label, cls] = EVENT_TEXT[ev.type] || [ev.type, ''];
      const p = ev.payload || {};
      const extra = p.tool ? ` · ${p.tool}${p.ok === false ? ' (falhou)' : ''}` : p.device ? ` · ${p.device}` : p.code ? ` · ${p.code}` : '';
      this.log(label + extra, p.ok === false ? 'warn' : cls);
    },
    async step() {
      if (!Backend.online) { this.data = null; this.push(0, 0, 0, 0); this.draw(); return; }
      try {
        const d = await Api.get('/api/system/status');
        this.data = d;
        this.uptimeBase = d.uptime_seconds; this.uptimeAt = Date.now();
        this.push(d.cpu_percent, d.ram_percent, d.net_down_mbps + d.net_up_mbps, Math.min(100, d.jarvis_process.cpu_percent));
      } catch { this.data = null; }
      this.draw();
    },
    push(cpu, ram, net, core) {
      const vals = { cpu, ram, net, core };
      Object.entries(this.metrics).forEach(([k, m]) => {
        m.v = vals[k];
        m.hist.push(m.v);
        if (m.hist.length > 60) m.hist.shift();
      });
      this.metrics.net.max = Math.max(10, ...this.metrics.net.hist) * 1.2;
    },
    tickUptime() {
      const el = $('#uptime');
      if (this.uptimeBase == null || !Backend.online) { el.textContent = '--:--:--'; return; }
      el.textContent = fmtDuration((this.uptimeBase * 1000) + (Date.now() - this.uptimeAt));
    },
    draw() {
      if (Router.current !== 'sistema') return;
      $$('.gauge').forEach((g) => {
        const m = this.metrics[g.dataset.metric];
        const pct = clamp(m.v / m.max, 0, 1);
        g.querySelector('.g-fill').style.strokeDashoffset = (314.16 * (1 - pct)).toFixed(1);
        g.querySelector('.g-val b').textContent = Backend.online ? (g.dataset.metric === 'net' ? m.v.toFixed(1) : m.v.toFixed(0)) : '--';
        g.classList.toggle('hot', g.dataset.metric !== 'net' && pct > 0.85);
        const { ctx, w, h } = fitCanvas(g.querySelector('.spark'));
        ctx.clearRect(0, 0, w, h);
        if (m.hist.length < 2) return;
        const xs = w / 59;
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, Theme.c(0.3)); grad.addColorStop(1, Theme.c(0));
        ctx.beginPath();
        m.hist.forEach((v, i) => { const x = i * xs, y = h - clamp(v / m.max, 0, 1) * (h - 4) - 2; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.strokeStyle = Theme.c(0.9, 65); ctx.lineWidth = 1.2; ctx.stroke();
        ctx.lineTo((m.hist.length - 1) * xs, h); ctx.lineTo(0, h); ctx.closePath();
        ctx.fillStyle = grad; ctx.fill();
      });
      const d = this.data;
      const labels = { cpu: 'CPU', ram: 'RAM', net: 'NETWORK', core: 'CORE (JARVIS)', ...(d?.labels || {}) };
      $$('.gauge').forEach((g) => { g.querySelector('.g-name').textContent = labels[g.dataset.metric]; });
      $('#sysBuild').textContent = Backend.status?.version || '—';
      $('#sysOs').textContent = d?.os || '—';
      $('#sysTemp').textContent = d?.gpu ? `${d.gpu.temp_c.toFixed(0)}°C` : '—';
      $('#sysThreads').textContent = d ? d.jarvis_process.threads : '—';
      $('#procBody').innerHTML = d
        ? d.modules.map((p) => {
          const s = p.status.toLowerCase();
          const cls = s.startsWith('ativo') ? 'ok' : s.includes('não') || s.includes('indispon') || s.includes('erro') ? 'warn' : '';
          return `<tr><td>${esc(p.name)}</td><td><span class="tag ${cls}">${esc(p.status.toUpperCase())}</span></td></tr>`;
        }).join('')
        : '<tr><td>núcleo</td><td><span class="tag bad">OFFLINE</span></td></tr>';
    },
    async diagnose() {
      const btn = $('#sysDiag');
      btn.disabled = true;
      this.log('Diagnóstico solicitado…', 'acc');
      const s = await Backend.poll(true);
      if (!s) {
        this.log('Backend não respondeu — inicie com "python main.py"', 'bad');
        Notify.push({ type: 'bad', title: 'Diagnóstico', sub: 'Núcleo offline', target: 'sistema' });
        btn.disabled = false;
        return;
      }
      const checks = [
        ['Núcleo / API', true, `v${s.version}`],
        ['Banco de dados', s.database === 'ok', s.database],
        ['Modelo de IA', s.model.available, s.model.available ? `${s.model.provider}/${s.model.name}` : s.model.error],
        ['Pesquisa web', s.modules.web_search.configured, s.modules.web_search.configured ? 'configurada' : 'não configurada'],
        ['Voz', false, 'não conectada (FASE 5)'],
        ['Câmera / visão', s.modules.vision.camera === 'connected', 'não conectada (FASE 6)'],
        ['Ferramentas', true, `${s.tools.length} registradas`],
      ];
      for (const [name, ok, info] of checks) {
        await wait(140);
        this.log(`${name} ${'.'.repeat(Math.max(2, 20 - name.length))} ${ok ? 'OK' : 'PENDENTE'} · ${info}`, ok ? 'ok' : 'warn');
      }
      const okCount = checks.filter((c) => c[1]).length;
      this.log(`Diagnóstico: ${okCount}/${checks.length} OK`, 'acc');
      Notify.push({ type: okCount === checks.length ? 'ok' : 'warn', title: 'Diagnóstico concluído', sub: `${okCount} de ${checks.length} módulos OK`, target: 'sistema' });
      btn.disabled = false;
    },
    async reboot() {
      const btn = $('#sysReboot');
      btn.disabled = true;
      this.log('Recarregando configuração do modelo (.env)…', 'warn');
      Core.set('boot');
      try {
        const d = await Api.post('/api/core/restart');
        this.log(`Modelo ${d.model.provider}/${d.model.name || '-'}: ${d.model.available ? 'disponível' : 'indisponível — ' + d.model.error}`, d.model.available ? 'ok' : 'warn');
        await Backend.poll();
      } catch (e) {
        this.log(`Falha ao reiniciar: ${e.message}`, 'bad');
      }
      Backend.settle();
      if (Core.state === 'boot') Core.set(Backend.baseState());
      btn.disabled = false;
    },
    async init() {
      $('#sysDiag').addEventListener('click', () => this.diagnose());
      $('#sysReboot').addEventListener('click', () => this.reboot());
      Router.on('sistema', { enter: () => { this.step(); } });
      setInterval(() => { if (Router.current === 'sistema') this.step(); }, 2000);
      setInterval(() => this.tickUptime(), 1000);
      Bus.on('backend', async ({ online }) => {
        this.log(online ? 'Conectado ao núcleo' : 'Conexão com o núcleo perdida', online ? 'ok' : 'bad');
        if (online) {
          try { (await Api.get('/api/events/recent?limit=20')).items.forEach((ev) => this.logEvent(ev)); } catch { /* ignora */ }
        }
      });
    },
  };

  /* ======================================================================
     SETTINGS UI — liga os controles da aba Configurações
     ====================================================================== */
  const SettingsUI = {
    fill(range) {
      const min = Number(range.min), max = Number(range.max);
      range.style.setProperty('--fill', `${((Number(range.value) - min) / (max - min)) * 100}%`);
    },
    labels() {
      $('#volVal').textContent = `${Math.round(Settings.v.volume * 100)}%`;
      $('#intVal').textContent = `${Math.round(Settings.v.intensity * 100)}%`;
      $('#denVal').textContent = `${Math.round(Settings.v.density * 100)}%`;
      $('#vrVal').textContent = `${Settings.v.voiceRate > 0 ? '+' : ''}${Settings.v.voiceRate}%`;
    },
    sync() {
      $$('[data-setting]').forEach((el) => {
        const v = Settings.v[el.dataset.setting];
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = v;
        if (el.type === 'range') this.fill(el);
      });
      $$('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === Settings.v.mode));
      this.labels();
    },
    init() {
      $$('[data-setting]').forEach((el) => {
        const key = el.dataset.setting;
        const evt = el.type === 'checkbox' || el.tagName === 'SELECT' || key === 'location' ? 'change' : 'input';
        el.addEventListener(evt, () => {
          let val = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
          if (typeof val === 'string' && !val.trim() && (key === 'userName' || key === 'location')) return;
          Settings.set(key, val);
          if (el.type === 'range') this.fill(el);
          if (el.type === 'checkbox') Sound.play('toggle');
          this.labels();
        });
      });
      $('#modes').addEventListener('click', (e) => {
        const b = e.target.closest('[data-mode]');
        if (!b) return;
        Settings.set('mode', b.dataset.mode);
        this.sync();
        Sound.play(b.dataset.mode === 'alerta' ? 'error' : 'toggle');
        Toast.show({ type: b.dataset.mode === 'alerta' ? 'bad' : 'info', title: `Modo ${b.querySelector('b').textContent}`, sub: 'Interface reconfigurada.' }, 2200);
      });
      $('#soundTest').addEventListener('click', () => {
        if (!Settings.v.sound) { Toast.show({ type: 'warn', title: 'Som desativado', sub: 'Ative "Sons da interface" para testar.' }); return; }
        Sound.play('boot');
      });
      $('#setReset').addEventListener('click', () => {
        Settings.reset();
        this.sync();
        Toast.show({ type: 'ok', title: 'Configurações restauradas', sub: 'Valores padrão aplicados.' });
      });
      this.sync();
    },
  };

  /* ======================================================================
     BOOT — sequência de inicialização (verifica o backend de verdade)
     ====================================================================== */
  const Boot = {
    done: false,
    finish() {
      if (this.done) return;
      this.done = true;
      $('#boot').classList.add('done');
      document.body.classList.add('booted');
      Core.set(Backend.baseState());
      Router.moveIndicator();
      setTimeout(() => Router.moveIndicator(), 900);
    },
    line(text, result, cls = '') {
      const div = document.createElement('div');
      div.innerHTML = `&gt; ${esc(text)} <span class="dim">${'.'.repeat(Math.max(2, 44 - text.length))}</span> <b class="${cls}">${esc(result)}</b>`;
      $('#bootLog').appendChild(div);
    },
    async run() {
      $('#bootSkip').addEventListener('click', () => this.finish());
      $('#boot').addEventListener('dblclick', () => this.finish());
      const fast = !Settings.v.boot || !Settings.v.animations;
      const bar = $('#bootBar');
      const step = async (i, n) => { bar.style.width = `${(i / n) * 100}%`; if (!fast) await wait(rand(160, 280)); };
      this.line('Carregando interface HUD', 'OK');
      await step(1, 5);
      const s = await Backend.poll();
      if (this.done) return;
      this.line('Conectando ao núcleo (API)', s ? `v${s.version}` : 'OFFLINE', s ? '' : 'bad');
      await step(2, 5);
      this.line(`Memória (${s?.storage === 'artifact-db' ? 'banco do artifact' : s?.storage === 'navegador' ? 'navegador' : 'SQLite'})`, s ? (s.database === 'ok' ? 'OK' : 'ERRO') : '—', s && s.database === 'ok' ? '' : 'bad');
      await step(3, 5);
      this.line('Modelo de IA', s ? (s.model.available ? `${s.model.provider.toUpperCase()}` : 'INDISPONÍVEL') : '—', s?.model.available ? '' : 'warn');
      await step(4, 5);
      this.line('Voz / visão', 'NÃO CONECTADAS', 'warn');
      await step(5, 5);
      if (!fast) await wait(400);
      this.finish();
    },
  };

  /* ======================================================================
     KEYS — atalhos de teclado
     ====================================================================== */
  const Keys = {
    init() {
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (Voice.out.speaking || Chat.busy) { Chat.stop(); return; }   // Esc interrompe a resposta/fala
          if (Modal.isOpen()) Modal.close();
          else Notify.close();
          return;
        }
        const typing = e.target.closest('input, textarea, select, [contenteditable]');
        if (typing || e.ctrlKey || e.metaKey || e.altKey || Modal.isOpen()) return;
        if (/^[1-8]$/.test(e.key)) { Router.go(Router.pages[Number(e.key) - 1]); return; }
        if (e.key === '/') { e.preventDefault(); Router.go('inicio'); setTimeout(() => $('#homeInput').focus(), 250); return; }
        if (e.key.toLowerCase() === 'n') Notify.toggle();
      });
    },
  };

  /* ======================================================================
     NETWORK — indicador de conexão (estado real online/offline do navegador)
     ====================================================================== */
  const Network = {
    update() {
      const online = navigator.onLine;
      const el = $('#netIndicator');
      el.classList.toggle('down', !online);
      el.title = online ? 'Internet conectada' : 'Sem internet — operando localmente';
    },
    init() {
      this.update();
      window.addEventListener('online', () => { this.update(); Notify.push({ type: 'ok', title: 'Internet restabelecida', sub: 'Rede' }); });
      window.addEventListener('offline', () => { this.update(); Notify.push({ type: 'bad', title: 'Internet perdida', sub: 'Rede · operando localmente' }); });
    },
  };

  /* ======================================================================
     APP — inicialização na ordem correta
     ====================================================================== */
  const App = {
    init() {
      Store.load();
      Settings.load();
      Settings.apply();
      Core.set('boot');
      Sound.init();
      Effects.init();
      Clock.init();
      Modal.init();
      Notify.init();
      Core.init();
      City.init();
      Particles.init();
      Wave.init();
      Globe.init();
      WorldMap.init();
      Home.init();
      Chat.init();
      Voice.init();
      Projects.init();
      Memory.init();
      Vision.init();
      Devices.init();
      System.init();
      SettingsUI.init();
      HomeUI.init();
      Location.init();
      Router.init(); // depois dos módulos registrarem seus hooks
      Network.init();
      Keys.init();
      Backend.init();
      Boot.run();
      window.JARVIS = { Api, Backend, Location, Core, Router, Notify, Settings, System, Chat, Projects, Devices, Vision, Memory };
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => App.init());
  else App.init();
})();
