/* ==========================================================================
   JARVIS · NÚCLEO WEB (versão que roda dentro do claude.ai)

   É o mesmo núcleo do backend Python (brain → router → ferramentas/IA →
   memória → eventos), portado para o navegador. A interface fala com ele
   pelas MESMAS rotas /api/... — por isso nada no visual muda.

   - IA: Claude do plano do usuário (capability `sample`).
   - Memória, conversas e projeto: banco do artifact (capability `db`),
     na área privada do usuário; sem db, usa o armazenamento do navegador.
   - Ferramentas reais aqui: calculadora, memória, projetos, status do
     navegador, dispositivos, câmera (estado). Arquivos, pesquisa web e abrir
     programas/sites existem só na versão local (python main.py).

   Este arquivo NÃO é carregado na versão local: lá quem responde é o Python.
   ========================================================================== */
(() => {
  'use strict';
  const VERSION = '0.3.0-web';
  const STARTED = Date.now();

  /* ---------------- utilitários ---------------- */
  const stripAccents = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  const normalizeKey = (t) => stripAccents(String(t).toLowerCase()).replace(/^[\s.!?,;:"']+|[\s.!?,;:"']+$/g, '')
    .replace(/^(o|a|os|as|meu|minha|meus|minhas)\s+/, '').replace(/\s+/g, ' ');
  const STOP = new Set('a o as os um uma de da do das dos e que qual quais meu minha meus minhas seu sua para pra por com em no na nos nas eu voce me isso esse essa ser sao como jarvis'.split(' '));
  const keywords = (t) => (stripAccents(String(t).toLowerCase()).match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !STOP.has(w));
  const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
  const CATEGORIES = ['pessoal', 'projetos', 'preferencias', 'conhecimento', 'conversas', 'sistema', 'contexto'];

  /* ---------------- armazenamento (db do artifact → navegador) ---------------- */
  const Storage = {
    db: null, uid: null, chains: {},
    async init() {
      try {
        const [db, user] = await Promise.all([window.claude?.use?.('db'), window.claude?.use?.('user')]);
        const uid = user ? await user.id() : null;
        if (db && uid) { this.db = db; this.uid = uid; }
      } catch { /* sem db: usa o navegador */ }
    },
    kind() { return this.db ? 'artifact-db' : 'navegador'; },
    async load(name) {
      if (this.db) {
        try {
          const snap = await this.db.collection(`data/users/${this.uid}`).doc(`jarvis_${name}`).get();
          return snap.exists ? JSON.parse(JSON.stringify(snap.data())) : null;
        } catch { /* cai para o navegador */ }
      }
      try { return JSON.parse(localStorage.getItem(`jarvis.web.${name}`)); } catch { return null; }
    },
    save(name, value) {   // uma escrita por vez por documento
      const body = JSON.parse(JSON.stringify(value));
      this.chains[name] = (this.chains[name] || Promise.resolve()).then(async () => {
        if (this.db) {
          try { await this.db.collection(`data/users/${this.uid}`).doc(`jarvis_${name}`).set(body); return; } catch { /* cai para o navegador */ }
        }
        try { localStorage.setItem(`jarvis.web.${name}`, JSON.stringify(body)); } catch { /* sem armazenamento */ }
      });
      return this.chains[name];
    },
  };

  /* ---------------- eventos ---------------- */
  const Events = {
    listeners: new Set(), recent: [],
    emit(type, payload = {}) {
      const ev = { type, payload, ts: new Date().toISOString() };
      this.recent.push(ev);
      if (this.recent.length > 200) this.recent.shift();
      this.listeners.forEach((fn) => { try { fn(ev); } catch (e) { console.error(e); } });
      return ev;
    },
  };

  /* ---------------- estado ---------------- */
  const State = { processing: false, active_tool: null, current_project: 'jarvis', microphone: 'not_connected', speaker: 'not_connected', camera: 'not_connected', vision_model: 'not_configured' };

  /* ---------------- modelo: Claude do plano (sample) ---------------- */
  const Model = {
    sample: null, tools: false, error: 'conectando…',
    async init() {
      try {
        this.sample = await window.claude?.use?.('sample');
        if (!this.sample) { this.error = 'IA do Claude indisponível nesta visualização'; return; }
        const lim = await this.sample.limits().catch(() => null);
        this.tools = !!lim?.tools;
        this.error = null;
      } catch { this.sample = null; this.error = 'IA do Claude indisponível nesta visualização'; }
    },
    get available() { return !!this.sample && !this.error; },
    status() { return { provider: 'claude', name: 'plano Claude', available: this.available, error: this.error }; },
    mapError(e) {
      const code = e?.code || 'upstream_error';
      if (code === 'not_granted' || code === 'sampling_disabled' || code === 'not_declared' || code === 'capability_disabled') {
        this.error = 'Uso do Claude não autorizado nesta página';
        return err('MODEL_UNAVAILABLE', 'Você não autorizou o JARVIS a usar o Claude do seu plano (ou ele está desativado). Recarregue a página e permita quando pedir.', 503);
      }
      if (code === 'rate_limited') return err('MODEL_RATE_LIMITED', 'Limite de uso do seu plano atingido por agora. Tente de novo mais tarde.', 503);
      if (code === 'session_expired') return err('MODEL_AUTH_FAILED', 'Sua sessão do Claude expirou. Entre novamente.', 503);
      if (code === 'prompt_too_large') return err('MODEL_ERROR', 'A conversa ficou grande demais. Inicie uma nova conversa.', 503);
      if (code === 'refused') return err('MODEL_ERROR', 'O modelo recusou essa mensagem. Tente reformular.', 503);
      return err('MODEL_ERROR', 'O modelo não conseguiu responder agora. Tente de novo.', 503);
    },
  };

  /* ---------------- memória + conversas + projeto ---------------- */
  const Mem = {
    data: { seq: 0, items: [] },
    remember(content, category = 'pessoal', key = null, source = 'user', importance = 0.5) {
      if (!CATEGORIES.includes(category)) throw err('INVALID_CATEGORY', `Categoria inválida. Use: ${CATEGORIES.join(', ')}`);
      content = String(content).trim();
      if (!content) throw err('INVALID_ARGS', 'Conteúdo vazio.');
      const nkey = key ? normalizeKey(key) : null;
      let m = nkey ? this.data.items.find((x) => x.key === nkey) : null;
      if (m) Object.assign(m, { content, category, source, importance, updated_at: nowSql() });
      else {
        m = { id: ++this.data.seq, category, key: nkey, content, source, importance, created_at: nowSql(), updated_at: nowSql() };
        this.data.items.push(m);
      }
      Storage.save('memories', this.data);
      return { ...m };
    },
    recall(key) {
      const nkey = normalizeKey(key);
      return this.data.items.find((x) => x.key === nkey)
        || this.data.items.filter((x) => x.key && nkey && x.key.includes(nkey)).sort((a, b) => a.key.length - b.key.length)[0] || null;
    },
    list(category = null, limit = 500) {
      return this.data.items.filter((m) => !category || m.category === category)
        .sort((a, b) => (b.updated_at.localeCompare(a.updated_at)) || b.id - a.id).slice(0, limit).map((m) => ({ ...m }));
    },
    search(query, limit = 5, category = null) {
      const terms = keywords(query);
      if (!terms.length) return [];
      return this.list(category).map((m) => {
        const hay = stripAccents(`${m.key || ''} ${m.content}`.toLowerCase());
        const s = terms.filter((t) => hay.includes(t)).length;
        return [s ? s + m.importance : 0, m];
      }).filter(([s]) => s).sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, m]) => m);
    },
    forget(id) {
      const n = this.data.items.length;
      this.data.items = this.data.items.filter((m) => m.id !== Number(id));
      if (this.data.items.length !== n) { Storage.save('memories', this.data); return true; }
      return false;
    },
    counts() {
      const out = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
      this.data.items.forEach((m) => { out[m.category]++; });
      return out;
    },
  };

  const Conv = {
    data: { seq: 0, msgSeq: 0, list: [] },   // list: [{id, updated_at, messages:[]}]
    get(id) { return this.data.list.find((c) => c.id === Number(id)) || null; },
    create() {
      const c = { id: ++this.data.seq, updated_at: nowSql(), messages: [] };
      this.data.list.push(c);
      this.data.list = this.data.list.slice(-20);   // guarda as 20 conversas mais recentes
      this.save();
      return c.id;
    },
    latest() { return this.data.list.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id)[0]?.id ?? null; },
    add(id, role, content, route = null) {
      const c = this.get(id);
      const m = { id: ++this.data.msgSeq, role, content, route, created_at: nowSql() };
      c.messages.push(m);
      c.messages = c.messages.slice(-200);
      c.updated_at = nowSql();
      this.save();
      return m.id;
    },
    history(id, limit = 50) { return (this.get(id)?.messages || []).slice(-limit).map((m) => ({ ...m })); },
    save() { Storage.save('chat', this.data); },
  };

  const PROJECT = {
    slug: 'jarvis', code: 'PRJ-001', name: 'JARVIS', subtitle: 'JARVIS CORE', status: 'Em desenvolvimento',
    description: 'Inteligência pessoal modular: núcleo, memória, ferramentas, voz, visão e dispositivos.', tags: ['ia', 'core', 'python'],
    milestones: [
      [1, 'Interface HUD v0.1', 'done'], [2, 'Fase 1 — Core, API e LLM', 'done'], [3, 'Fase 2 — Memória SQLite', 'done'],
      [4, 'Fase 3 — Ferramentas', 'in_progress'], [5, 'Fase 4 — Interface conectada', 'in_progress'], [6, 'Fase 5 — Voz', 'pending'],
      [7, 'Fase 6 — Visão computacional', 'pending'], [8, 'Fase 7 — Controle do computador', 'pending'], [9, 'Fase 8 — Dispositivos', 'pending'],
      [10, 'Fase 9 — Gestos', 'pending'], [11, 'Fase 10 — AR / AXIOM SIGHT', 'pending'],
    ],
  };
  const Projects = {
    overrides: {},   // id do marco → status
    shape(withMs) {
      const ms = PROJECT.milestones.map(([id, title, status]) => ({ id, position: id, title, status: this.overrides[id] || status }));
      const done = ms.filter((m) => m.status === 'done').length + 0.5 * ms.filter((m) => m.status === 'in_progress').length;
      const p = { slug: PROJECT.slug, code: PROJECT.code, name: PROJECT.name, subtitle: PROJECT.subtitle, status: PROJECT.status,
        description: PROJECT.description, tags: PROJECT.tags, progress: Math.round((100 * done) / ms.length) };
      if (withMs) p.milestones = ms;
      return p;
    },
    list() { return [this.shape(false)]; },
    get(slug) { return String(slug).toLowerCase() === 'jarvis' ? this.shape(true) : null; },
    setMilestone(slug, id, status) {
      if (!['pending', 'in_progress', 'done'].includes(status)) throw err('INVALID_ARGS', 'status deve ser pending, in_progress ou done');
      if (!this.get(slug)) throw err('PROJECT_NOT_FOUND', `Projeto '${slug}' não encontrado.`, 404);
      if (!PROJECT.milestones.some(([mid]) => mid === Number(id))) throw err('MILESTONE_NOT_FOUND', 'Marco não encontrado.', 404);
      this.overrides[Number(id)] = status;
      Storage.save('project_jarvis', this.overrides);
      return this.get(slug);
    },
  };

  /* ---------------- telemetria do navegador (dados reais, mas do navegador) ---------------- */
  const Telemetry = {
    lag: 0, battery: null,
    init() {
      let last = performance.now();
      setInterval(() => {   // atraso do relógio = quanto o navegador está ocupado
        const now = performance.now();
        this.lag = this.lag * 0.7 + Math.max(0, now - last - 500) * 0.3;
        last = now;
      }, 500);
      navigator.getBattery?.().then((b) => {
        const upd = () => { this.battery = { percent: Math.round(b.level * 100), plugged: b.charging }; };
        upd(); b.addEventListener('levelchange', upd); b.addEventListener('chargingchange', upd);
      }).catch(() => {});
    },
    os() { return navigator.userAgentData?.platform || navigator.platform || 'navegador'; },
    snapshot() {
      const pm = performance.memory;
      const heapUsed = pm ? pm.usedJSHeapSize : 0;
      return {
        cpu_percent: Math.min(100, (this.lag / 500) * 100),
        cpu_count: navigator.hardwareConcurrency || null,
        ram_percent: pm ? (pm.usedJSHeapSize / pm.jsHeapSizeLimit) * 100 : 0,
        ram_used_gb: +(heapUsed / 1024 ** 3).toFixed(2),
        ram_total_gb: navigator.deviceMemory || null,
        disk_percent: null,
        net_down_mbps: navigator.connection?.downlink || 0,
        net_up_mbps: 0,
        battery: this.battery,
        gpu: null,
        jarvis_process: { cpu_percent: State.processing ? 100 : 0, ram_mb: +(heapUsed / 1024 ** 2).toFixed(1), threads: navigator.hardwareConcurrency || 1 },
        os: `${this.os()} · navegador`,
        labels: { cpu: 'CARGA (UI)', ram: 'MEMÓRIA JS', net: 'REDE (EST.)', core: 'CORE (IA)' },
      };
    },
  };

  const Devices = {
    list() {
      const s = Telemetry.snapshot();
      const pending = (id, name, kind, icon, protocol, phase) => ({ id, name, kind, icon, protocol, status: 'not_connected', integration: 'future',
        info: { note: `Integração disponível futuramente (${phase})`, planned_protocol: protocol } });
      return [
        { id: 'workstation', name: 'Workstation', kind: 'Computador', icon: 'monitor', protocol: 'local', status: 'connected', integration: 'real',
          info: { hostname: 'este navegador', os: Telemetry.os(), cpu_percent: Math.round(s.cpu_percent), ram_percent: Math.round(s.ram_percent), battery: s.battery } },
        pending('smartphone', 'Smartphone', 'Mobile', 'phone', 'WebSocket (Wi-Fi local)', 'FASE 8'),
        pending('axiom_band', 'Axiom Band', 'Wearable', 'watch', 'Bluetooth Low Energy (BLE)', 'FASE 8'),
        pending('camera_main', 'Câmera Principal', 'Sensor óptico', 'camera', 'USB / webcam (OpenCV)', 'FASE 6'),
        pending('ar_glasses', 'Óculos AR', 'Protótipo', 'glasses', 'BLE + Wi-Fi', 'FASE 10'),
      ];
    },
  };

  const VISION = { camera: 'not_connected', signal: 'SINAL ÓPTICO AUSENTE', detector: { model: 'none', available: false, note: 'disponível futuramente (FASE 6)' },
    tracking: { available: false, note: 'disponível futuramente (FASE 6)' }, gestures: { available: false, note: 'disponível futuramente (FASE 9)' } };

  /* ---------------- calculadora segura (parser próprio, sem eval) ---------------- */
  const Calc = {
    FUNCS: { sqrt: Math.sqrt, raiz: Math.sqrt, abs: Math.abs, round: Math.round, sin: Math.sin, cos: Math.cos, tan: Math.tan,
      log: Math.log10, ln: Math.log, exp: Math.exp, floor: Math.floor, ceil: Math.ceil },
    CONSTS: { pi: Math.PI, e: Math.E },
    toExpression(text) {
      let t = stripAccents(String(text).toLowerCase()).replace(/^[\s?=]+|[\s?=]+$/g, '');
      t = t.replace(/(\d+(?:[.,]\d+)?)\s*%\s*de\s*(\d+(?:[.,]\d+)?)/g, '($1/100*$2)');
      [[/\bvezes\b/g, '*'], [/\bmultiplicado por\b/g, '*'], [/\bdividido por\b/g, '/'], [/\bmais\b/g, '+'], [/\bmenos\b/g, '-'],
        [/\belevado a\b/g, '**'], [/\bao quadrado\b/g, '**2'], [/\bao cubo\b/g, '**3'], [/\braiz quadrada de\s+([\d.]+)/g, 'sqrt($1)']]
        .forEach(([re, rep]) => { t = t.replace(re, rep); });
      t = t.replace(/×/g, '*').replace(/÷/g, '/').replace(/\^/g, '**').replace(/(\d)\s*x\s*(?=\d)/g, '$1*').replace(/(\d),(\d)/g, '$1.$2');
      return t.trim();
    },
    evaluate(src) {
      if (src.length > 200) throw err('EXPRESSION_TOO_LONG', 'Expressão longa demais.');
      const toks = src.match(/\d+(?:\.\d+)?|[a-z_]+|\*\*|\/\/|[+\-*/%(),]|\S/g) || [];
      let i = 0;
      const peek = () => toks[i];
      const eat = (t) => { if (toks[i] !== t) throw err('INVALID_EXPRESSION', 'Não entendi essa expressão matemática.'); i++; };
      const expr = () => { let v = term(); while (peek() === '+' || peek() === '-') { const op = toks[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; };
      const term = () => {
        let v = unary();
        while (['*', '/', '//', '%'].includes(peek())) {
          const op = toks[i++]; const r = unary();
          if ((op !== '*') && r === 0) throw err('DIVISION_BY_ZERO', 'Divisão por zero não tem resultado.');
          v = op === '*' ? v * r : op === '/' ? v / r : op === '//' ? Math.floor(v / r) : ((v % r) + r) % r;
        }
        return v;
      };
      const unary = () => { if (peek() === '-') { i++; return -unary(); } if (peek() === '+') { i++; return unary(); } return power(); };
      const power = () => {
        const base = atom();
        if (peek() === '**') { i++; const ex = unary(); if (Math.abs(ex) > 10000) throw err('EXPRESSION_TOO_LARGE', 'Expoente grande demais.'); return base ** ex; }
        return base;
      };
      const atom = () => {
        const t = toks[i++];
        if (t === undefined) throw err('INVALID_EXPRESSION', 'Expressão incompleta.');
        if (/^\d/.test(t)) return parseFloat(t);
        if (t === '(') { const v = expr(); eat(')'); return v; }
        if (/^[a-z_]+$/.test(t)) {
          if (t in this.CONSTS && peek() !== '(') return this.CONSTS[t];
          if (t in this.FUNCS) { eat('('); const args = [expr()]; while (peek() === ',') { i++; args.push(expr()); } eat(')'); return this.FUNCS[t](...args); }
        }
        throw err('INVALID_EXPRESSION', 'A expressão contém algo que não é matemática.');
      };
      const v = expr();
      if (i !== toks.length) throw err('INVALID_EXPRESSION', 'Não entendi essa expressão matemática.');
      if (!Number.isFinite(v)) throw err('MATH_ERROR', 'Resultado fora do alcance.');
      return v;
    },
    format(v) { return Number(v.toFixed(6)).toLocaleString('pt-BR', { maximumFractionDigits: 6 }); },
    run(expression) {
      const expr = this.toExpression(expression);
      const v = this.evaluate(expr);
      const pretty = expr.replace(/\*\*/g, '^').replace(/\*/g, ' × ').replace(/\//g, ' ÷ ').replace(/\s+/g, ' ').trim();
      return { message: `${pretty} = ${this.format(v)}`, data: { expression: expr, result: v } };
    },
  };

  /* ---------------- ferramentas (mesmas regras de linguagem do backend) ---------------- */
  const POSS = { meu: 'seu', minha: 'sua', meus: 'seus', minhas: 'suas' };
  const V = '(?:é|e|eh|são|sao)';
  const RX = {
    calcTrigger: /^(?:jarvis[,\s]+)?(?:quanto\s+(?:e|da|eh|fica|vale)|calcul[ae]r?|resolv[ae]r?|conta:?)\s+(.+?)\s*\??$/,
    calcPure: /^[\d\s.,+\-*/()^%x×÷]+$/,
    memSave: /^(?:jarvis[,\s]+)?(?:lembre(?:-se)?|lembra|anote|anota|guarde|guarda|salve|salva|memorize|grave)\s+(?:que\s+|de\s+que\s+|isso:?\s*)?(.+)$/i,
    memStatement: new RegExp(`^(?:jarvis[,\\s]+)?(?:o\\s+|a\\s+)?(meu|minha|meus|minhas)\\s+(.{2,40}?)\\s+${V}\\s+(.+?)[.!]*$`, 'i'),
    memMoro: /^(?:jarvis[,\s]+)?eu\s+moro\s+(?:em|no|na|nos|nas)\s+(.+?)[.!]*$/i,
    memNome: /^(?:jarvis[,\s]+)?(?:me\s+chamo|pode\s+me\s+chamar\s+de|me\s+chame\s+de)\s+(.+?)[.!]*$/i,
    memGosto: /^(?:jarvis[,\s]+)?eu\s+(gosto|adoro|amo|prefiro|odeio|não gosto|nao gosto)\s+(?:de\s+|da\s+|do\s+)?(.+?)[.!]*$/i,
    memRecall: new RegExp(`^(?:jarvis[,\\s]+)?(?:qual|quais)\\s+${V}\\s+(?:o\\s+|a\\s+|os\\s+|as\\s+)?(meu|minha|meus|minhas)\\s+(.+?)\\s*\\??$`, 'i'),
    memWhere: /^(?:jarvis[,\s]+)?onde\s+(?:é\s+que\s+)?eu\s+moro\s*\??$/i,
    memName: /^(?:jarvis[,\s]+)?(?:como\s+(?:eu\s+)?me\s+chamo|como\s+prefiro\s+ser\s+chamado)\s*\??$/i,
    memList: /o\s+que\s+(?:voc[eê]|vc)\s+(?:sabe|lembra)\s+(?:sobre|de)\s+mim|(?:liste|mostre|mostra)\s+(?:as\s+)?(?:suas\s+|minhas\s+)?mem[oó]rias/i,
    memForget: /^(?:jarvis[,\s]+)?(?:esque[cç]a|esquece)\s+(?:que\s+|o\s+|a\s+)?(?:(meu|minha|meus|minhas)\s+)?(.+?)[.!]*$/i,
    projList: /(?:quais\s+(?:s[aã]o\s+)?(?:os\s+)?meus\s+projetos|(?:liste|mostre|mostra)\s+(?:os\s+)?(?:meus\s+)?projetos)/i,
    projStatus: /(?:status|progresso|andamento)\s+(?:do|da)\s+(?:projeto\s+)?([\w\- ]+?)\s*\??$/i,
    sysStatus: /(?:status|uso|consumo|desempenho)\s+(?:do|da|de)?\s*(?:sistema|cpu|processador|mem[oó]ria|ram|computador|pc|gpu|placa de v[ií]deo)|como\s+(?:est[aá]|t[aá])\s+(?:o\s+)?(?:meu\s+)?(?:pc|computador|sistema)|n[ií]vel\s+da\s+bateria/i,
    devices: /(?:quais|que)\s+dispositivos\s+(?:est[aã]o|tenho|eu\s+tenho|conectad)|dispositivos\s+conectados|status\s+dos\s+dispositivos|(?:axiom\s+band|smartphone|celular|[oó]culos)\s+(?:est[aá]|t[aá])\s+conectad/i,
    camera: /c[aâ]mera\s+(?:est[aá]|t[aá])\s+(?:ligad|conectad|funcionand)|status\s+da\s+c[aâ]mera|o\s+que\s+(?:voc[eê]|vc)\s+(?:est[aá]\s+)?vendo|analis[ae]\s+(?:essa|esta|a)\s+imagem/i,
    files: /(?:leia|ler|abra|abrir|mostre|mostra)\s+(?:o\s+|meu\s+)?arquivo|(?:liste|listar|mostre|quais\s+s[aã]o)\s+(?:os\s+)?(?:meus\s+)?arquivos|n(?:os|o)\s+(?:meus\s+)?arquivos/i,
    web: /^(?:jarvis[,\s]+)?(?:pesquis[ae]r?|procur[ae]r?|busc[ae]r?)\s+(?:na\s+(?:web|internet)\s+)?(?:sobre\s+|por\s+)?(.{3,})$/i,
    open: /^(?:jarvis[,\s]+)?(?:abr[ae]|abrir|inici[ae]r?|execut[ae]r?|acesse|acessar)\s+(?:o\s+|a\s+)?(vs\s*code|visual studio code|bloco de notas|notepad|calculadora|explorador de arquivos|explorer|terminal|site\s+\S+|\S+\.\S+)\s*[.!]*$/i,
  };
  const CAT_HINTS = [['projetos', ['projeto', 'startup', 'produto', 'empresa', 'jarvis', 'app', 'site', 'loja', 'marca']],
    ['preferencias', ['gosto', 'prefer', 'favorit', 'cor', 'comida', 'musica', 'time', 'filme', 'odeio', 'adoro']],
    ['conhecimento', ['aprendi', 'estudo', 'sei ', 'curso', 'linguagem']]];
  const guessCategory = (t) => { const s = stripAccents(String(t).toLowerCase()); return (CAT_HINTS.find(([, h]) => h.some((x) => s.includes(x))) || ['pessoal'])[0]; };
  const sentence = (t) => { t = String(t).trim().replace(/[.!]+$/, ''); return t.charAt(0).toUpperCase() + t.slice(1) + '.'; };
  const toSecond = (text) => {
    const rules = [[/^meu\b/i, 'Seu'], [/^minha\b/i, 'Sua'], [/^meus\b/i, 'Seus'], [/^minhas\b/i, 'Suas'], [/^eu moro\b/i, 'Você mora'],
      [/^eu gosto\b/i, 'Você gosta'], [/^eu adoro\b/i, 'Você adora'], [/^eu amo\b/i, 'Você ama'], [/^eu prefiro\b/i, 'Você prefere'],
      [/^eu odeio\b/i, 'Você odeia'], [/^eu n[aã]o gosto\b/i, 'Você não gosta'], [/^me chamo\b/i, 'Você se chama']];
    for (const [re, rep] of rules) { const n = text.replace(re, rep); if (n !== text) return n; }
    return text;
  };
  const LOCAL_ONLY = 'Isso funciona só na versão local do JARVIS (rodando python main.py no seu computador). Aqui na página web eu não tenho acesso a arquivos, programas, sites nem à internet.';

  const Tools = [
    { name: 'calculator', risk: 'low',
      match(t) { const s = stripAccents(t.toLowerCase()).trim(); const m = s.match(RX.calcTrigger); if (m && /\d/.test(m[1])) return { expression: m[1] };
        if (RX.calcPure.test(s) && /\d\s*[+\-*/^x×÷%]\s*\d/.test(s)) return { expression: s }; return null; },
      execute: ({ expression }) => ({ ok: true, ...Calc.run(expression) }) },
    { name: 'projects', risk: 'low',
      match(t) { if (RX.projList.test(t)) return { action: 'list' }; const m = t.match(RX.projStatus); return m ? { action: 'get', slug: stripAccents(m[1].toLowerCase()).trim().replace(/ /g, '-') } : null; },
      execute({ action, slug }) {
        if (action === 'list') return { ok: true, message: Projects.list().map((p) => `• ${p.name} — ${p.status} (${p.progress}%)`).join('\n').replace(/^/, 'Projetos ativos:\n') };
        const p = Projects.get(slug || 'jarvis');
        if (!p) return { ok: false, message: `Não encontrei o projeto “${slug}”.`, error_code: 'PROJECT_NOT_FOUND' };
        const doing = p.milestones.filter((m) => m.status === 'in_progress').map((m) => m.title);
        return { ok: true, message: `${p.name} — ${p.status}, ${p.progress}% concluído.${doing.length ? `\nEm andamento: ${doing.join(', ')}.` : ''}` };
      } },
    { name: 'memory', risk: 'low',
      riskFor: (a) => (a.action === 'forget' ? 'medium' : 'low'),
      describe(a) { const h = Mem.recall(a.key || ''); return h ? `apagar da memória: “${h.content}”` : `apagar da memória o que sei sobre ${a.key}`; },
      statement(t) {
        let m;
        if ((m = t.match(RX.memStatement)) && m[2].trim().split(/\s+/).length <= 5) return { action: 'save', key: m[2].trim(), content: sentence(t), category: guessCategory(`${m[2]} ${m[3]}`) };
        if ((m = t.match(RX.memMoro))) return { action: 'save', key: 'cidade onde mora', content: sentence(t), category: 'pessoal' };
        if ((m = t.match(RX.memNome))) return { action: 'save', key: 'nome', content: sentence(t), category: 'pessoal' };
        if ((m = t.match(RX.memGosto))) return { action: 'save', content: sentence(t), category: 'preferencias' };
        return null;
      },
      match(t) {
        t = t.trim(); let m;
        if (RX.memList.test(t)) return { action: 'list' };
        if (RX.memWhere.test(t)) return { action: 'recall', key: 'cidade onde mora', possessive: 'minha' };
        if (RX.memName.test(t)) return { action: 'recall', key: 'nome', possessive: 'meu' };
        if ((m = t.match(RX.memRecall))) return { action: 'recall', key: m[2], possessive: m[1].toLowerCase() };
        if (t.endsWith('?')) return null;
        if ((m = t.match(RX.memForget))) return { action: 'forget', key: m[2], possessive: (m[1] || 'meu').toLowerCase() };
        if ((m = t.match(RX.memSave))) { const inner = m[1].trim(); return this.statement(inner) || { action: 'save', content: sentence(inner), category: guessCategory(inner) }; }
        return this.statement(t);
      },
      execute({ action, content, key, category, possessive = 'meu' }) {
        if (action === 'save') { const m = Mem.remember(content, category || guessCategory(content), key || null); const conv = toSecond(m.content); return { ok: true, message: conv !== m.content ? `Anotado. ${conv}` : `Anotado: “${m.content}”`, memory_changed: true }; }
        if (action === 'recall') {
          const m = Mem.recall(key);
          return { ok: true, message: m ? toSecond(m.content) : `Ainda não sei qual é ${POSS[possessive] || 'seu'} ${normalizeKey(key)}. Se quiser, me conte e eu guardo.` };
        }
        if (action === 'list') {
          const items = Mem.list(null, 15);
          return { ok: true, message: items.length ? `Isto é o que tenho guardado:\n${items.map((m) => `• ${toSecond(m.content)}`).join('\n')}` : 'Ainda não tenho nada salvo sobre você.' };
        }
        if (action === 'forget') {
          const m = Mem.recall(key);
          if (!m) return { ok: true, message: `Não encontrei nada sobre “${key}” na memória.` };
          Mem.forget(m.id);
          return { ok: true, message: `Pronto, esqueci: “${m.content}”`, memory_changed: true };
        }
        throw err('INVALID_ARGS', `Ação desconhecida: ${action}`);
      } },
    { name: 'system', risk: 'low',
      match: (t) => (RX.sysStatus.test(t) ? {} : null),
      execute() {
        const s = Telemetry.snapshot();
        const parts = [`carga da interface ${s.cpu_percent.toFixed(0)}%`, `${s.cpu_count || '?'} núcleos`, s.ram_total_gb ? `~${s.ram_total_gb} GB de RAM` : null,
          s.battery ? `bateria ${s.battery.percent}%${s.battery.plugged ? ' (carregando)' : ''}` : null].filter(Boolean);
        return { ok: true, message: `Na versão web eu só enxergo o navegador: ${parts.join(', ')}. O uso real de CPU, RAM e GPU aparece na versão local.` };
      } },
    { name: 'devices', risk: 'low',
      match: (t) => (RX.devices.test(t) ? {} : null),
      execute() {
        const items = Devices.list();
        return { ok: true, message: `Conectado: ${items.filter((d) => d.status === 'connected').map((d) => d.name).join(', ')}.\nNão conectado (integração futura): ${items.filter((d) => d.status !== 'connected').map((d) => d.name).join(', ')}.` };
      } },
    { name: 'camera', risk: 'low',
      match: (t) => (RX.camera.test(t) ? {} : null),
      execute: () => ({ ok: true, message: 'Sinal óptico ausente: nenhuma câmera está conectada ao JARVIS ainda. A visão computacional entra na FASE 6.' }) },
    { name: 'local_only', risk: 'low',
      match: (t) => (RX.files.test(t) || (RX.web.test(t.trim()) && !Model.available) || RX.open.test(t.trim()) ? {} : null),   // com o modelo, "pesquise" vira resposta honesta: sem internet aqui
      execute: () => ({ ok: true, message: LOCAL_ONLY }) },
  ];
  const toolByName = (n) => Tools.find((t) => t.name === n);
  const routeText = (text) => {
    for (const t of Tools) { try { const a = t.match(text); if (a) return { tool: t, args: a }; } catch (e) { console.error(e); } }
    return null;
  };
  const runTool = (tool, args) => {
    State.active_tool = tool.name;
    Events.emit('TOOL_STARTED', { tool: tool.name });
    let r;
    try { r = tool.execute(args); } catch (e) { r = { ok: false, message: e.message, error_code: e.code || 'TOOL_FAILED' }; }
    Events.emit('TOOL_FINISHED', { tool: tool.name, ok: r.ok, code: r.error_code || null });
    if (r.memory_changed) Events.emit('MEMORY_UPDATED', { source: 'chat' });
    State.active_tool = null;
    return r;
  };

  /* ---------------- permissões (confirmação de ações de risco) ---------------- */
  const Pending = {
    map: new Map(),
    YES: /^(sim|s|pode|pode sim|confirmo|confirmar|ok|claro|manda|faz|faca|yes|y|isso)\b/,
    NO: /^(nao|n|cancela|cancelar|negativo|para|pare|no)\b/,
    resolve(conv, text) {
      const a = this.map.get(conv);
      if (!a) return ['none', null];
      this.map.delete(conv);
      if (Date.now() - a.created > 300000) return ['none', null];
      const t = stripAccents(text.toLowerCase()).replace(/[\s.!?]+$/, '').trim();
      if (this.YES.test(t)) return ['yes', a];
      if (this.NO.test(t)) return ['no', a];
      return ['none', a];
    },
  };

  /* ---------------- conhecimento local (mesma base do knowledge/marvel_seed.json) ---------------- */
  const UNIVERSES = {
    MCU: 'MCU (filmes e séries da Marvel Studios)', COMICS_616: 'Quadrinhos (Terra-616, continuidade principal)',
    COMICS_ALT: 'Quadrinhos (outras realidades, ex.: Ultimate)', SSU: "Sony's Spider-Man Universe",
    FILMS_OTHER: 'Outros filmes (fora do MCU, ex.: trilogia de Sam Raimi)', ANIMATED: 'Animações', GAME: 'Jogos',
    REAL_WORLD: 'Mundo real (criação, publicação, bastidores)',
  };
  const U_RX = {
    MCU: /\bmcu\b|universo cinematografico|marvel studios|nos filmes da marvel|\bfilmes?\b(?! do sam raimi| do raimi| da sony)/,
    COMICS_616: /quadrinhos?|\bhqs?\b|gibis?|comics?|\b616\b|terra-616/, COMICS_ALT: /\bultimate\b|realidade alternativa|terra-1610/,
    SSU: /\bssu\b|universo (?:do )?homem-aranha da sony|sony'?s spider-man universe|filmes da sony/,
    FILMS_OTHER: /sam raimi|\braimi\b|tobey maguire|andrew garfield|espetacular homem-aranha/,
    ANIMATED: /animacao|animacoes|desenho|aranhaverso|spider-verse|animad/, GAME: /\bjogos?\b|\bgames?\b|insomniac|playstation|\bps[45]\b|videogame/,
  };
  const PRED = { created: 'criou', used: 'usou', identity_of: 'é a identidade de / atua como', member_of: 'é membro de', worked_at: 'trabalhou em',
    mentor_of: 'é mentor de', evolved_into: 'evoluiu para', part_of: 'faz parte de', replaced: 'substituiu', ally_of: 'é aliado de', enemy_of: 'é inimigo de' };
  const KB = {
    data: window.JARVIS_KB || { entities: [], facts: [], relations: [] }, aliases: [], byslug: {},
    n(t) { return ' ' + stripAccents(String(t).toLowerCase()).replace(/\.(?=\s|$)/g, ' ').replace(/[^a-z0-9.\- ]+/g, ' ') + ' '; },
    init() {
      const pairs = new Map();
      for (const e of this.data.entities) {
        this.byslug[e.slug] = e;
        for (const a of [...(e.aliases || []), e.name, e.slug]) { const na = this.n(a).trim(); if (na.length >= 3) pairs.set(na, e.slug); }
      }
      this.aliases = [...pairs.entries()].sort((a, b) => b[0].length - a[0].length);
    },
    universes(text) {
      const t = stripAccents(String(text).toLowerCase());
      const f = Object.keys(U_RX).filter((u) => U_RX[u].test(t));
      if (f.includes('FILMS_OTHER') && f.includes('MCU') && !/\bmcu\b|marvel studios/.test(t)) f.splice(f.indexOf('MCU'), 1);
      return f;
    },
    detect(text) {
      let t = this.n(String(text).replace(/^\s*(ok[,\s]+)?jarvis[,!.\s]+/i, ''));
      const found = new Map();
      for (const [alias, slug] of this.aliases) {
        const pos = t.indexOf(` ${alias} `);
        if (pos >= 0) { t = t.split(` ${alias} `).join(' ' + ' '.repeat(alias.length) + ' '); if (!found.has(slug) || found.get(slug) > pos) found.set(slug, pos); }
      }
      return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([s]) => s);
    },
    name(slug) { return this.byslug[slug]?.name || slug; },
    rel(slug, us) { return this.data.relations.filter((r) => (r.subject === slug || r.object === slug) && (!us || us.includes(r.universe))); },
    relText(r) { return `${this.name(r.subject)} ${PRED[r.predicate] || r.predicate} ${this.name(r.object)}`; },
    connections(a, b, us) {
      const out = [], other = (r, me) => (r.subject === me ? r.object : r.subject);
      const ra = this.rel(a, us), rb = this.rel(b, us);
      ra.filter((r) => [r.subject, r.object].includes(b)).forEach((r) => out.push([r]));
      for (const r of ra) { const mid = other(r, a); if (mid === a || mid === b) continue; rb.filter((r2) => other(r2, b) === mid && r2.universe === r.universe).forEach((r2) => out.push([r, r2])); }
      return out;
    },
    contextFor(question, extra = []) {
      const slugs = this.detect(question);
      extra.forEach((s) => { if (!slugs.includes(s)) slugs.push(s); });
      const wanted = this.universes(question);
      if (!slugs.length) return { block: '', sources: [], slugs, wanted };
      const facts = this.data.facts.filter((f) => slugs.slice(0, 6).includes(f.entity) && (!wanted.length || wanted.includes(f.universe) || f.universe === 'REAL_WORLD'));
      const order = Object.keys(UNIVERSES);
      const byU = {};
      facts.forEach((f) => { (byU[f.universe] = byU[f.universe] || []).push(f); });
      const lines = [];
      Object.keys(byU).sort((a, b) => order.indexOf(a) - order.indexOf(b)).forEach((u) => {
        lines.push(`[${UNIVERSES[u] || u}]`);
        byU[u].forEach((f) => lines.push(`- ${this.name(f.entity)}: ${f.fact} [fonte: ${f.source}]${(f.confidence ?? 0.8) >= 0.9 ? '' : ' (confiança média — verificar)'}`));
      });
      const rels = slugs.length >= 2
        ? this.connections(slugs[0], slugs[1], wanted.length ? wanted : null).slice(0, 8).map((p) => `${p.map((r) => this.relText(r)).join(' → ')} [${UNIVERSES[p[0].universe] || p[0].universe}]`)
        : this.rel(slugs[0], wanted.length ? wanted : null).slice(0, 10).map((r) => `${this.relText(r)} [${UNIVERSES[r.universe] || r.universe}]`);
      if (rels.length) lines.push('[Relações do grafo]', ...rels.map((x) => `- ${x}`));
      const seen = new Set(), sources = [];
      facts.forEach((f) => { const k = f.source + f.universe; if (!seen.has(k)) { seen.add(k); sources.push({ title: f.source, url: '', universe: f.universe, tier_label: 'Base de conhecimento local', provider: 'kb', confidence: f.confidence, last_verified: f.last_verified }); } });
      return { block: lines.join('\n'), sources: sources.slice(0, 12), slugs, wanted };
    },
    stats() { return { entities: this.data.entities.length, facts: this.data.facts.length, relations: this.data.relations.length }; },
  };

  /* ---------------- conversa: comandos, referências, assunto ---------------- */
  const VOC = '^(?:ok[,\\s]+|e\\s+ai[,\\s]+)?(?:jarvis[,!.\\s]+)?';
  const CMDS = [
    ['stop', new RegExp(VOC + '(?:para|pare|parar|espera|espere|perai|silencio|chega|stop|calma|um momento)[.!]*$')],
    ['cancel', new RegExp(VOC + '(?:cancela|cancele|cancelar|esquece|esqueca|deixa\\s+pra\\s+la|deixa\\s+quieto|deixa)[.!]*$')],
    ['continue', new RegExp(VOC + '(?:continua|continue|continuar|pode\\s+continuar|segue|siga|prossiga|vai\\s+em\\s+frente|e\\s+ai)[.!?]*$')],
    ['back', new RegExp(VOC + '(?:volta|voltar|volte|volta\\s+(?:pro|para\\s+o|ao)\\s+(?:assunto\\s+)?anterior|o\\s+anterior|a\\s+anterior)[.!]*$')],
    ['repeat', new RegExp(VOC + '(?:repete|repita|repetir|fala\\s+de\\s+novo|diz\\s+de\\s+novo|o\\s+que\\s+(?:voce|vc)\\s+disse)[.!?]*$')],
    ['explain', new RegExp(VOC + '(?:me\\s+)?(?:explica|explique|detalha|detalhe|aprofunda|aprofunde)\\s*(?:melhor|mais|isso|isso\\s+melhor)?[.!?]*$|^(?:jarvis[,\\s]+)?(?:como\\s+assim|mais\\s+detalhes)[.!?]*$')],
    ['rephrase', new RegExp(VOC + '(?:(?:fala|diz|explica|explique)\\s+de\\s+outro\\s+jeito|reformula|reformule|simplifica|simplifique|mais\\s+simples)[.!?]*$')],
    ['summarize', new RegExp(VOC + '(?:resume|resuma|resumir|faz\\s+um\\s+resumo)(?:\\s+isso|\\s+tudo)?[.!?]*$')],
  ];
  const CMD_NOTE = { continue: 'Continue a sua resposta anterior de onde parou, sem repetir o que já disse.',
    explain: 'Explique melhor a sua última resposta, com mais detalhes e um exemplo concreto.', rephrase: 'Reformule a sua última resposta de um jeito mais simples e direto.',
    summarize: 'Resuma a sua última resposta (ou o assunto atual) em 2 ou 3 frases.', back: 'Retome o assunto anterior indicado no contexto.' };
  const REF_RX = /\b(isso|isto|aquilo|nisso|disso|daquilo|ele|ela|eles|elas|dele|dela|deles|delas|nele|nela|esse|essa|desse|dessa|nesse|nessa|aquele|aquela|daquele|daquela|o mesmo|a mesma|a outra opção|a outra|o outro)\b/i;
  const CONTR = { dele: 'de', dela: 'de', deles: 'de', delas: 'de', disso: 'de', daquilo: 'de', desse: 'de', dessa: 'de', daquele: 'de', daquela: 'de', nele: 'em', nela: 'em', nisso: 'em', nesse: 'em', nessa: 'em' };
  const KCUE = /\b(mcu|quadrinhos?|hqs?|universo|vers[aã]o|vers[oõ]es|armadura|traje|criou|criado|inventou|primeir[oa]|depois|diferen[cç]a|rela[cç][aã]o|filme|filmes|anima[cç][aã]o|jogo)\b/i;
  const ASKRX = /\?\s*$|^(?:jarvis[,\s]+)?(quem|o que|qual|quais|quando|onde|como|por que|quanto|existe|tem|me (?:fala|fale|conta|conte|explica|explique)|explica|explique|compare|compara)\b/i;
  const CURRENT = /\b(hoje|agora|atualmente|atual|atuais|recentes?|ultim[oa]s?|noticias?|novidades?|lancamentos?|lancou|esta semana|este mes|este ano|ontem|preco|precos|cotacao|placar|previsao|20(2[5-9]|3\d)|mais nov[oa])\b/;
  const SEARCH_RX = /^(?:jarvis[,\s]+)?(?:pesquis[ae]r?|procur[ae]r?|busc[ae]r?)\b/i;
  const Talk = {
    command(text) { const t = stripAccents(text.toLowerCase()).trim(); return (CMDS.find(([, rx]) => rx.test(t)) || ['none'])[0]; },
    analyze(c, text) {
      const cmd = this.command(text);
      const m = text.match(REF_RX);
      const follow = !!m && !!c.topic;
      let standalone = text;
      if (follow && !/outr[oa]/i.test(m[0])) {
        const prep = CONTR[stripAccents(m[0].toLowerCase())];
        standalone = text.replace(new RegExp(`\\b${m[0]}\\b`, 'i'), prep ? `${prep} ${c.topic}` : c.topic);
      }
      const notes = [];
      if (c.topic) notes.push(`Assunto atual da conversa: ${c.topic}.`);
      if (follow) notes.push(`A mensagem usa “${m[0]}”, que provavelmente se refere a: ${c.topic}.`);
      if (cmd === 'back' && c.stack?.length) notes.push(`O usuário quer voltar ao assunto anterior: ${c.stack[c.stack.length - 1]}.`);
      if (CMD_NOTE[cmd]) notes.push(CMD_NOTE[cmd]);
      return { cmd, follow, standalone, notes };
    },
    setTopic(c, topic) {
      if (!topic || topic === c.topic) return;
      c.stack = [...(c.stack || []), c.topic].filter(Boolean).slice(-5);
      c.topic = topic;
    },
  };

  /* ---------------- contexto + IA ---------------- */
  const buildRules = (client, text) => {
    const name = client?.user_name || 'José Marcelo';
    const p = Projects.get('jarvis');
    const rel = Mem.search(text, 6);
    const facts = Mem.list(null, 40).filter((m) => m.key).slice(0, 10);
    const seen = new Set();
    const mems = [...rel, ...facts].filter((m) => !seen.has(m.id) && seen.add(m.id)).map((m) => `- [${m.category}] ${m.content}`);
    const first = name.split(' ')[0];
    return `INSTRUÇÕES DE SISTEMA (não são do usuário)
Você é JARVIS, a inteligência pessoal de ${name}. Trate-o por "${first}" quando fizer sentido.

QUEM VOCÊ É
- Extremamente competente, calmo e rápido. Educado sem ser formal demais. Confiante, discreto e observador.
- Humor leve e ocasional, nunca teatral. Português do Brasil natural. Nada de "Sim, senhor", bajulação ou frases de filme.
- Respostas curtas (1 a 4 frases) por padrão, em texto simples SEM Markdown (podem ser lidas em voz alta). Listas só com "1.", "2.".

PRIORIDADES: verdade, contexto, utilidade, clareza, personalidade.
- Não sabe? "Não tenho informação suficiente." Nunca invente fatos, fontes, pesquisas ou ações.
- Diferencie MEMÓRIA do usuário, CONHECIMENTO GERAL (seu e da base local) e INFORMAÇÃO ATUAL.
- Esta é a VERSÃO WEB: você NÃO tem internet, arquivos, programas, câmera nem microfone. Informação atual não pode ser verificada aqui — diga isso.
- Ficção com várias continuidades (MCU, quadrinhos, outros filmes, animações, jogos): nunca misture; diga de qual universo está falando.
- Quando o usuário contar algo duradouro sobre ele, salve com a ferramenta salvar_memoria.

SITUAÇÃO
- Horário local do usuário: ${client?.local_time || new Date().toLocaleString('pt-BR')}
${client?.location ? `- Localização: ${client.location}\n` : ''}${client?.weather ? `- Clima local: ${client.weather}\n` : ''}- Projeto atual: ${p.name} (${p.status}, ${p.progress}% concluído)

MEMÓRIA (fatos salvos sobre o usuário)
${mems.join('\n') || '- (nada salvo ainda)'}

As próximas mensagens são a conversa com ${name.split(' ')[0]}.`;
  };

  const LLM_TOOLS = (used) => [
    { name: 'calcular', description: 'Calcula uma expressão matemática com precisão. Retorna o resultado formatado.',
      inputSchema: { type: 'object', properties: { expressao: { type: 'string', description: 'ex.: 500*20, 10% de 300, sqrt(2)' } }, required: ['expressao'] },
      execute: (i) => { used.add('calculator'); const r = runTool(toolByName('calculator'), { expression: String(i.expressao || '') }); if (!r.ok) throw new Error(r.message); return r.message; } },
    { name: 'salvar_memoria', description: 'Salva um fato duradouro sobre o usuário na memória de longo prazo. Use frases em primeira pessoa do usuário, ex.: "Eu prefiro respostas curtas."',
      inputSchema: { type: 'object', properties: { conteudo: { type: 'string' }, categoria: { type: 'string', enum: CATEGORIES }, assunto: { type: 'string', description: 'chave curta opcional, ex.: "cor favorita"' } }, required: ['conteudo'] },
      execute: (i) => { used.add('memory'); const r = runTool(toolByName('memory'), { action: 'save', content: sentence(String(i.conteudo || '')), category: CATEGORIES.includes(i.categoria) ? i.categoria : guessCategory(String(i.conteudo || '')), key: i.assunto ? String(i.assunto) : null }); return r.message; } },
    { name: 'buscar_memoria', description: 'Procura na memória fatos sobre o usuário relacionados a uma consulta. Retorna a lista encontrada.',
      inputSchema: { type: 'object', properties: { consulta: { type: 'string' } }, required: ['consulta'] },
      execute: (i) => { used.add('memory'); return Mem.search(String(i.consulta || ''), 8).map((m) => m.content); } },
    { name: 'status_projeto', description: 'Retorna o projeto JARVIS com suas fases e progresso.',
      execute: () => { used.add('projects'); return Projects.get('jarvis'); } },
  ];

  async function askModel(text, conv, client, extra = {}) {
    if (!Model.available) throw err('MODEL_UNAVAILABLE', `${Model.error || 'IA indisponível'}. Mesmo assim já consigo: cálculos, memória, projetos e status.`, 503);
    const past = Conv.history(conv, 13).slice(0, -1).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.route !== 'error');
    const ctx = [extra.notes?.length ? `CONTEXTO DA CONVERSA\n${extra.notes.map((n) => `- ${n}`).join('\n')}` : '', extra.knowledge || ''].filter(Boolean).join('\n\n');
    const turns = [{ role: 'user', content: buildRules(client, text) }, ...past.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: ctx ? `${ctx}\n\nMENSAGEM DO USUÁRIO: ${text}` : text }];
    const used = new Set();
    const opts = { cache: false, modelTier: ['quick', 'default', 'complex'].includes(client?.model_tier) ? client.model_tier : 'quick' };
    if (Model.tools) opts.tools = LLM_TOOLS(used);
    if (extra.onText) opts.onText = extra.onText;
    if (extra.signal) opts.signal = extra.signal;          // botão PARAR / Esc / "pare" cancelam de verdade
    Events.emit('AI_THINKING', { conversation_id: conv });
    try {
      const res = await Model.sample(turns, opts);
      return { text: res.text.trim() + (res.truncated ? '\n(resposta cortada pelo limite de tamanho)' : ''), tool: [...used][0] || null };
    } catch (e) {
      if (e?.code === 'tools_unavailable') { Model.tools = false; return askModel(text, conv, client, extra); }
      if (e?.code === 'cancelled') return { text: e.text || '', tool: null, cancelled: true };
      throw Model.mapError(e);
    }
  }

  /* ---------------- cérebro (streaming: start · state · delta · sources · done) ---------------- */
  const running = new Map();   // conversa → { cancelled }
  async function handleChatStream({ message, conversation_id, client }, emit = () => {}, signal = null) {
    const text = String(message || '').trim();
    if (!text) throw err('INVALID_REQUEST', 'Requisição inválida: message vazia', 422);
    const conv = conversation_id && Conv.get(conversation_id) ? Number(conversation_id) : Conv.create();
    const c = Conv.get(conv);
    const run = { cancelled: false, ctl: new AbortController(), cancel() { this.cancelled = true; this.ctl.abort(); } };
    running.set(conv, run);
    signal?.addEventListener?.('abort', () => run.cancel());
    const t0 = performance.now();
    const phase = (p) => { if (!run.cancelled) { emit({ event: 'state', phase: p }); Events.emit('STATE_CHANGED', { phase: p, conversation_id: conv }); } };
    emit({ event: 'start', conversation_id: conv });
    Conv.add(conv, 'user', text);
    Events.emit('MESSAGE_RECEIVED', { conversation_id: conv, chars: text.length });
    State.processing = true;
    phase('THINKING');
    let streamed = '', firstMs = null;
    const onText = (u) => {                 // o runtime manda {text: resposta inteira até agora, delta}
      const t = typeof u === 'string' ? u : u?.text;
      if (run.cancelled || typeof t !== 'string') return;
      const delta = t.startsWith(streamed) ? t.slice(streamed.length) : (u?.delta ?? t);
      if (!delta) return;
      if (firstMs == null) { firstMs = performance.now() - t0; phase('PROCESSING'); }
      streamed += delta;
      emit({ event: 'delta', text: delta });
    };
    const a = Talk.analyze(c, text);
    let reply, sources = [], topic = null;
    try {
      const [verdict, action] = Pending.resolve(conv, text);
      if (verdict === 'yes') {
        phase('EXECUTING');
        const r = runTool(toolByName(action.tool), action.args);
        reply = { text: r.message, route: 'tool', tool: action.tool };
      } else if (verdict === 'no') {
        reply = { text: 'Ok, cancelei. Nada foi executado.', route: 'cancelled', tool: action.tool };
      } else if (a.cmd === 'stop' || a.cmd === 'cancel') {
        reply = { text: a.cmd === 'stop' ? 'Ok, parei.' : 'Cancelado.', route: 'command' };
      } else if (a.cmd === 'repeat') {
        reply = { text: c.last || 'Ainda não disse nada nesta conversa.', route: 'command' };
      } else {
        const hit = a.cmd === 'none' ? routeText(a.standalone) : null;
        const plainT = stripAccents(text.toLowerCase());
        // conhecimento local: entidade citada (ou o assunto da conversa) + pergunta, e não é informação atual
        let k = null;
        if (!hit && a.cmd === 'none' && !CURRENT.test(plainT) && !SEARCH_RX.test(text)) {
          const extra = (!KB.detect(a.standalone).length && c.topic && KCUE.test(text) && ASKRX.test(text.trim())) ? KB.detect(c.topic) : [];
          const ctx = KB.contextFor(a.standalone, extra);
          if (ctx.block && (ASKRX.test(a.standalone.trim()) || KCUE.test(text))) k = ctx;
        }
        if (hit) {
          const risk = hit.tool.riskFor ? hit.tool.riskFor(hit.args) : hit.tool.risk;
          if (risk !== 'low') {
            const desc = hit.tool.describe(hit.args);
            Pending.map.set(conv, { tool: hit.tool.name, args: hit.args, created: Date.now() });
            Events.emit('CONFIRMATION_REQUIRED', { conversation_id: conv, tool: hit.tool.name, risk });
            reply = { text: `Posso ${desc}? Responda “sim” para confirmar ou “não” para cancelar.`, route: 'confirm', tool: hit.tool.name,
              pending: { id: String(Date.now()), tool: hit.tool.name, risk, description: desc } };
          } else {
            phase('EXECUTING');
            const r = runTool(hit.tool, hit.args);
            reply = { text: r.message, route: 'tool', tool: hit.tool.name };
          }
        } else if (k) {
          sources = k.sources;
          topic = KB.name(k.slugs[0]);
          emit({ event: 'tool', tool: 'knowledge', status: 'started' });
          emit({ event: 'sources', items: sources, conflicts: [] });
          const instr = 'CONHECIMENTO (base local, separado por universo). Responda com base nele. NÃO misture universos — se a pergunta não especificar, diga como é em cada um. Fatos marcados "verificar" exigem cautela. Se não responder, diga que não tem informação suficiente (pode usar o que sabe, deixando claro que é conhecimento geral).';
          if (Model.available) {
            const r = await askModel(text, conv, client, { notes: a.notes, knowledge: `${instr}\n${k.block}`, onText, signal: run.ctl.signal });
            reply = { text: r.text, route: 'tool', tool: 'knowledge' };
          } else {
            const head = `Isto é o que tenho na base de conhecimento${k.wanted.length ? ` (${k.wanted.map((u) => UNIVERSES[u]).join(', ')})` : ''}, separado por universo:\n`;
            reply = { text: head + k.block.replace(/ \[fonte: [^\]]+\]/g, ''), route: 'tool', tool: 'knowledge' };
          }
        } else {
          const notes = [...a.notes];
          const wantsSearch = SEARCH_RX.test(text) || (CURRENT.test(plainT) && ASKRX.test(text.trim()));
          if (wantsSearch) {
            notes.push('O usuário pediu informação atual/pesquisa, mas nesta versão web você NÃO tem internet. Comece dizendo isso em uma frase curta (sem pedir desculpas demais). Depois, se puder ajudar com o que já sabe, deixe claro que é conhecimento do modelo e pode estar desatualizado. Sugira a versão local para pesquisa real com fontes.');
            emit({ event: 'tool', tool: 'web', status: 'unavailable' });
          }
          const r = await askModel(text, conv, client, { notes, onText, signal: run.ctl.signal });
          reply = { text: r.text, route: r.tool ? 'tool' : 'llm', tool: r.tool };
        }
      }
    } catch (e) {
      reply = { text: e.message, route: 'error', error: e };
      Events.emit('AI_ERROR', { conversation_id: conv, code: e.code || 'ERROR' });
    } finally {
      State.processing = false;
      State.active_tool = null;
      running.delete(conv);
    }
    if (run.cancelled) reply = { text: streamed.trim() || '(interrompido)', route: 'cancelled' };
    if (!['error', 'cancelled'].includes(reply.route)) {
      c.last = reply.text;
      if (a.cmd === 'back' && c.stack?.length) { c.topic = c.stack.pop(); }
      else if (!a.follow && a.cmd === 'none') Talk.setTopic(c, topic || (KB.detect(text)[0] ? KB.name(KB.detect(text)[0]) : null) || c.topic);
      Conv.save();
    }
    const mid = Conv.add(conv, 'assistant', reply.text, reply.tool && reply.route === 'tool' ? `tool:${reply.tool}` : reply.route);
    if (sources.length) { const m = c.messages.find((x) => x.id === mid); if (m) { m.sources = sources; Conv.save(); } }
    Events.emit('AI_RESPONSE', { conversation_id: conv, route: reply.route, tool: reply.tool || null });
    const metrics = { llm_first_ms: firstMs == null ? null : Math.round(firstMs), total_ms: Math.round(performance.now() - t0), route: reply.route };
    Events.emit('METRICS', metrics);
    const final = reply.route === 'error' ? 'ERROR' : reply.route === 'confirm' ? 'WAITING_CONFIRMATION' : 'IDLE';
    Events.emit('STATE_CHANGED', { phase: final, conversation_id: conv });
    const done = { event: 'done', reply: reply.text, conversation_id: conv, message_id: mid, route: { type: reply.route, tool: reply.tool || null },
      pending_confirmation: reply.pending || null, sources, metrics, error: reply.route === 'error' ? { code: reply.error?.code || 'ERROR', message: reply.text } : null };
    if (!run.cancelled) { emit({ event: 'state', phase: final }); emit(done); }
    return done;
  }

  async function handleChat(body) {
    const d = await handleChatStream(body);
    if (d.route.type === 'error') throw Object.assign(err(d.error.code, d.reply, 503), { conversation_id: d.conversation_id });
    return d;
  }

  /* ---------------- "API" (mesmas rotas do server.py) ---------------- */
  const status = () => ({
    version: VERSION, online: true, model: Model.status(), database: 'ok', storage: Storage.kind(),
    state: { ...State, online: true, model: Model.status(), uptime_seconds: Math.round((Date.now() - STARTED) / 1000) },
    modules: {
      voice: { microphone: 'browser', speaker: 'browser', speech_to_text: { engine: 'browser', available: false, note: 'microfone não liberado na versão web' }, text_to_speech: { engine: 'browser', available: false, note: 'voz do navegador' }, ready: true, capture: 'navegador' },
      vision: VISION, web_search: { configured: false, note: 'sem internet na versão web' }, embeddings: { provider: 'none', available: false },
      knowledge: KB.stats(),
    },
    tools: Tools.map((t) => ({ name: t.name, risk: t.risk })),
  });

  const routes = [
    ['GET', /^\/api\/status$/, () => status()],
    ['POST', /^\/api\/core\/restart$/, async () => { await Model.init(); Events.emit('JARVIS_READY', { version: VERSION, model_available: Model.available, restarted: true }); return { model: Model.status() }; }],
    ['POST', /^\/api\/chat$/, (m, q, b) => handleChat(b || {})],
    ['GET', /^\/api\/chat\/history$/, (m, q) => {
      const id = Number(q.get('conversation_id')) || Conv.latest();
      if (!id) return { conversation_id: null, messages: [] };
      if (!Conv.get(id)) throw err('CONVERSATION_NOT_FOUND', 'Conversa não encontrada.', 404);
      return { conversation_id: id, messages: Conv.history(id, Number(q.get('limit')) || 50) };
    }],
    ['POST', /^\/api\/chat\/new$/, () => ({ conversation_id: Conv.create() })],
    ['POST', /^\/api\/chat\/cancel$/, (m, q, b) => { const r = running.get(Number(b?.conversation_id)); if (r) r.cancel(); return { cancelled: !!r }; }],
    ['GET', /^\/api\/voice\/status$/, () => status().modules.voice],
    ['POST', /^\/api\/voice\/state$/, () => ({ ok: true })],
    ['POST', /^\/api\/metrics\/client$/, () => ({ updated: false })],
    ['GET', /^\/api\/knowledge\/status$/, () => ({ knowledge_base: KB.stats(), general_web: false, note: 'sem internet na versão web' })],
    ['GET', /^\/api\/memory$/, (m, q) => {
      const cat = q.get('category');
      if (cat && !CATEGORIES.includes(cat)) throw err('INVALID_CATEGORY', `Categoria inválida. Use: ${CATEGORIES.join(', ')}`);
      const items = q.get('q') ? Mem.search(q.get('q'), Number(q.get('limit')) || 200, cat) : Mem.list(cat, Number(q.get('limit')) || 200);
      return { items, counts: Mem.counts(), categories: CATEGORIES };
    }],
    ['POST', /^\/api\/memory$/, (m, q, b) => { const r = Mem.remember(b.content, b.category || 'pessoal', b.key || null, 'interface'); Events.emit('MEMORY_UPDATED', { source: 'interface' }); return r; }],
    ['DELETE', /^\/api\/memory\/(\d+)$/, (m) => { if (!Mem.forget(m[1])) throw err('MEMORY_NOT_FOUND', 'Memória não encontrada.', 404); Events.emit('MEMORY_UPDATED', { source: 'interface' }); return { deleted: Number(m[1]) }; }],
    ['GET', /^\/api\/projects$/, () => ({ items: Projects.list(), current: State.current_project })],
    ['GET', /^\/api\/projects\/([^/]+)$/, (m) => { const p = Projects.get(decodeURIComponent(m[1])); if (!p) throw err('PROJECT_NOT_FOUND', `Projeto '${m[1]}' não encontrado.`, 404); return p; }],
    ['PATCH', /^\/api\/projects\/([^/]+)\/milestones\/(\d+)$/, (m, q, b) => { const p = Projects.setMilestone(decodeURIComponent(m[1]), m[2], b.status); Events.emit('PROJECT_UPDATED', { project: m[1] }); return p; }],
    ['GET', /^\/api\/devices$/, () => ({ items: Devices.list() })],
    ['GET', /^\/api\/vision\/status$/, () => VISION],
    ['POST', /^\/api\/vision\/start$/, () => { throw err('CAMERA_NOT_CONNECTED', 'Nenhuma câmera conectada ao JARVIS. A integração de câmera chega na FASE 6.', 409); }],
    ['GET', /^\/api\/system\/status$/, () => ({
      ...Telemetry.snapshot(), uptime_seconds: Math.round((Date.now() - STARTED) / 1000),
      modules: [
        { name: 'core.brain (web)', status: 'ativo' }, { name: 'llm.claude (plano)', status: Model.available ? 'ativo' : 'indisponível' },
        { name: `memory.${Storage.kind()}`, status: 'ativo' }, { name: 'tools', status: `${Tools.length} ativas` },
        { name: 'knowledge.engine', status: `${KB.stats().entities} entidades` }, { name: 'web.search', status: 'só na versão local' },
        { name: 'voice.tts', status: 'voz do navegador' }, { name: 'voice.stt', status: 'só na versão local' },
        { name: 'vision.cv', status: 'não conectado' }, { name: 'devices.mesh', status: '1/5 conectados' },
      ],
    })],
    ['GET', /^\/api\/events\/recent$/, (m, q) => ({ items: Events.recent.slice(-(Number(q.get('limit')) || 50)) })],
  ];

  let readyPromise = null;
  const ready = () => {
    if (!readyPromise) {
      readyPromise = (async () => {
        Telemetry.init();
        KB.init();
        await Storage.init();
        const [mem, chat, proj] = await Promise.all([Storage.load('memories'), Storage.load('chat'), Storage.load('project_jarvis')]);
        if (mem?.items) Mem.data = mem;
        if (chat?.list) Conv.data = chat;
        if (proj) Projects.overrides = proj;
        await Model.init();
        Events.emit('JARVIS_READY', { version: VERSION, model_available: Model.available });
        Events.emit('DEVICE_CONNECTED', { device: 'workstation' });
      })();
    }
    return readyPromise;
  };

  window.JarvisWebCore = {
    async request(method, path, body) {
      await ready();
      const url = new URL(path, 'http://jarvis.local');
      for (const [m, re, fn] of routes) {
        const match = method === m && url.pathname.match(re);
        if (match) return await fn(match, url.searchParams, body);
      }
      throw err('NOT_FOUND', `Endpoint ${url.pathname} não existe.`, 404);
    },
    subscribe(fn) { Events.listeners.add(fn); return () => Events.listeners.delete(fn); },
    async stream(path, body, onEvent, signal) {
      await ready();
      if (!/\/api\/chat\/stream$/.test(path)) throw err('NOT_FOUND', `Endpoint ${path} não existe.`, 404);
      await handleChatStream(body || {}, onEvent, signal);
    },
  };
  ready();
})();
