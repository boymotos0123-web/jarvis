-- 001: estrutura inicial do JARVIS

CREATE TABLE memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL CHECK (category IN ('pessoal','projetos','preferencias','conhecimento','conversas','sistema','contexto')),
    key         TEXT,                       -- chave normalizada (ex.: "projeto atual"); NULL = nota livre
    content     TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'user',
    importance  REAL NOT NULL DEFAULT 0.5,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_memories_key ON memories(key) WHERE key IS NOT NULL;
CREATE INDEX idx_memories_category ON memories(category);

CREATE TABLE conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
    content         TEXT NOT NULL,
    route           TEXT,                   -- 'llm', 'tool:calculator', 'confirm', 'error'...
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);

CREATE TABLE projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,
    code        TEXT NOT NULL,
    name        TEXT NOT NULL,
    subtitle    TEXT,
    status      TEXT NOT NULL,
    description TEXT,
    tags        TEXT NOT NULL DEFAULT '[]',     -- JSON
    visible     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE project_milestones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done'))
);

CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE devices (
    id          TEXT PRIMARY KEY,               -- ex.: 'workstation'
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    icon        TEXT NOT NULL,
    driver      TEXT NOT NULL,                  -- módulo em devices/
    protocol    TEXT NOT NULL,                  -- local | wifi | ble | websocket | rest | usb
    enabled     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,
    payload     TEXT NOT NULL DEFAULT '{}',     -- JSON (sem dados sensíveis)
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_type ON events(type, id);

-- Projeto inicial: somente JARVIS (novos projetos entram como novas linhas)
INSERT INTO projects (slug, code, name, subtitle, status, description, tags)
VALUES ('jarvis', 'PRJ-001', 'JARVIS', 'JARVIS CORE', 'Em desenvolvimento',
        'Inteligência pessoal modular: núcleo, memória, ferramentas, voz, visão e dispositivos.',
        '["ia","core","python"]');

INSERT INTO project_milestones (project_id, position, title, status) VALUES
  (1, 1,  'Interface HUD v0.1', 'done'),
  (1, 2,  'Fase 1 — Core, API e LLM', 'done'),
  (1, 3,  'Fase 2 — Memória SQLite', 'done'),
  (1, 4,  'Fase 3 — Ferramentas', 'in_progress'),
  (1, 5,  'Fase 4 — Interface conectada', 'in_progress'),
  (1, 6,  'Fase 5 — Voz', 'pending'),
  (1, 7,  'Fase 6 — Visão computacional', 'pending'),
  (1, 8,  'Fase 7 — Controle do computador', 'pending'),
  (1, 9,  'Fase 8 — Dispositivos', 'pending'),
  (1, 10, 'Fase 9 — Gestos', 'pending'),
  (1, 11, 'Fase 10 — AR / AXIOM SIGHT', 'pending');

INSERT INTO devices (id, name, kind, icon, driver, protocol) VALUES
  ('workstation', 'Workstation',      'Computador',     'monitor', 'workstation', 'local'),
  ('smartphone',  'Smartphone',       'Mobile',         'phone',   'smartphone',  'websocket'),
  ('axiom_band',  'Axiom Band',       'Wearable',       'watch',   'axiom_band',  'ble'),
  ('camera_main', 'Câmera Principal', 'Sensor óptico',  'camera',  'camera',      'usb'),
  ('ar_glasses',  'Óculos AR',        'Protótipo',      'glasses', 'ar_glasses',  'ble');

INSERT INTO settings (key, value) VALUES ('current_project', 'jarvis');
