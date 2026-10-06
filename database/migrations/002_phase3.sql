-- 002: Fase 3 — conversa, conhecimento, pesquisa, observabilidade

-- Compressão de contexto: resumo das partes antigas da conversa
ALTER TABLE conversations ADD COLUMN summary TEXT;
ALTER TABLE conversations ADD COLUMN summary_until INTEGER NOT NULL DEFAULT 0;   -- id da última mensagem resumida
ALTER TABLE conversations ADD COLUMN topic TEXT;                                 -- assunto atual (Conversation Engine)
ALTER TABLE messages ADD COLUMN sources TEXT;                                     -- JSON das fontes usadas na resposta

-- Base de conhecimento com metadados de canon/continuidade
CREATE TABLE kb_entities (
    slug             TEXT PRIMARY KEY,                 -- ex.: 'tony-stark'
    name             TEXT NOT NULL,
    type             TEXT NOT NULL,                    -- character | armor | ai | technology | organization | work | event | place
    aliases          TEXT NOT NULL DEFAULT '[]',       -- JSON
    summary          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE kb_facts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    entity           TEXT NOT NULL REFERENCES kb_entities(slug) ON DELETE CASCADE,
    fact             TEXT NOT NULL,
    universe         TEXT NOT NULL,                    -- MCU | COMICS_616 | SSU | ANIMATED | GAME | ALT | REAL_WORLD
    source           TEXT NOT NULL,                    -- obra ou referência (ex.: 'Iron Man (2008)')
    era              TEXT,                             -- data/época
    continuity       TEXT,
    confidence       REAL NOT NULL DEFAULT 0.8,
    canonical_status TEXT NOT NULL DEFAULT 'canon',    -- canon | semi-canon | non-canon | uncertain
    last_verified    TEXT
);
CREATE INDEX idx_kb_facts_entity ON kb_facts(entity, universe);

CREATE TABLE kb_relations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    subject          TEXT NOT NULL REFERENCES kb_entities(slug) ON DELETE CASCADE,
    predicate        TEXT NOT NULL,                    -- created | used | ally_of | mentor_of | worked_at | part_of | evolved_into | enemy_of | appears_in
    object           TEXT NOT NULL REFERENCES kb_entities(slug) ON DELETE CASCADE,
    universe         TEXT NOT NULL,
    source           TEXT NOT NULL,
    confidence       REAL NOT NULL DEFAULT 0.8
);
CREATE INDEX idx_kb_rel_subject ON kb_relations(subject, predicate);
CREATE INDEX idx_kb_rel_object ON kb_relations(object, predicate);

-- Cache de pesquisas (evita repetir a mesma busca)
CREATE TABLE search_cache (
    key              TEXT PRIMARY KEY,                 -- provedor + consulta normalizada
    provider         TEXT NOT NULL,
    query            TEXT NOT NULL,
    results          TEXT NOT NULL,                    -- JSON
    created_at       REAL NOT NULL,                    -- epoch
    ttl              REAL NOT NULL                     -- segundos
);

-- Observabilidade: tempos e ferramentas de cada resposta (sem conteúdo das mensagens)
CREATE TABLE metrics (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  INTEGER,
    route            TEXT,
    stt_ms           REAL,
    search_ms        REAL,
    llm_first_ms     REAL,
    llm_total_ms     REAL,
    tts_ms           REAL,
    total_ms         REAL,
    tools            TEXT NOT NULL DEFAULT '[]',
    sources          INTEGER NOT NULL DEFAULT 0,
    error            TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
