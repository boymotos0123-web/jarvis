# JARVIS — Personal Intelligence

Inteligência pessoal modular com interface HUD própria.
Versão **0.3.0** — fase 3: **CONVERSA NATURAL + STREAMING + VOZ + KNOWLEDGE ENGINE + PESQUISA COM FONTES**.

```
VOZ/TEXTO → INTERFACE → POST /api/chat/stream (SSE) → BRAIN
  → CONVERSATION ENGINE (comandos "pare/continua/volta", referências "isso/ele", assunto)
  → confirmação pendente? → tarefa de várias etapas (PLANNER)?
  → ROUTER (ferramenta) · KNOWLEDGE ENGINE (base local + grafo) · PESQUISA WEB (multi-fonte, ranking)
  → MODELO com streaming → texto chega palavra a palavra → VOZ fala frase a frase
  → histórico + fontes + métricas (SQLite) + eventos (SSE) → INTERFACE
```

> **Novo: JARVIS FPV Sim** — simulador de drone 3D no navegador (física a 400 Hz, controladora estilo Betaflight,
> corrida, pouso de precisão, gamepad/rádio/toque). Abra `/drone/` com o servidor rodando ou veja
> [`interface/drone/README.md`](interface/drone/README.md).

---
## 1. Instalação (Windows)

Pré-requisito: **Python 3.11 ou mais novo** (python.org — marque "Add python.exe to PATH").

```powershell
cd JARVIS
python -m venv .venv
.venv\Scripts\activate
python -m pip install -r requirements.txt
copy .env.example .env
```

> A voz neural usa o pacote `edge-tts` (já no requirements). Whisper local é opcional:
> `pip install faster-whisper` (precisa de PC com boa CPU/GPU).

> Se o PowerShell bloquear o `activate`, rode uma vez:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

**Linux / ChromeOS (Linux ativado) / macOS:**

```bash
cd JARVIS
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
```

## 2. Configuração (`.env`)

Abra o `.env` e escolha **um** provedor de IA:

| Provedor | `MODEL_PROVIDER` | Precisa de | Observação |
|---|---|---|---|
| OpenAI | `openai` | `API_KEY` | pago por uso; use um modelo "mini" |
| Groq | `groq` | `API_KEY` | tem plano gratuito, muito rápido |
| OpenRouter | `openrouter` | `API_KEY` | vários modelos numa chave só |
| Anthropic | `anthropic` | `API_KEY` | |
| Ollama (local) | `ollama` | Ollama instalado + `ollama pull <modelo>` | grátis, roda no seu PC (precisa de PC bom) |
| LM Studio (local) | `lmstudio` | LM Studio com servidor ligado | grátis, local |
| Nenhum | `none` | — | ferramentas, memória e base de conhecimento funcionam; conversa livre não |

`MODEL_NAME` = nome exato do modelo no provedor. Todos os provedores têm **streaming**.
Chaves **nunca** vão para o navegador nem para o log: só o backend as lê.

**Pesquisa** (opcional, mas recomendada):

| Fonte | Chave | Uso |
|---|---|---|
| Wikipedia · GitHub · arXiv | não precisa | enciclopédia, código, artigos científicos |
| Tavily (`TAVILY_API_KEY`) **ou** Brave (`BRAVE_API_KEY`) | grátis para começar | web geral, notícias e sites oficiais (marvel.com, gov.br, docs...) |
| `GITHUB_TOKEN` | opcional | aumenta o limite de buscas no GitHub |

Sem Tavily/Brave o JARVIS **diz** que não consegue verificar informação atual — não inventa.

**Voz:**

| Variável | Valores |
|---|---|
| `TTS_PROVIDER` | `edge` (voz neural pt-BR-AntonioNeural, precisa de internet) · `browser` (voz do navegador) |
| `TTS_VOICE` | ex.: `pt-BR-AntonioNeural`, `pt-BR-FabioNeural` |
| `STT_PROVIDER` | `browser` (Chrome/Edge — o áudio vai ao serviço de fala do navegador) · `whisper` (endpoint local, ver seção 8) |
| `PERMISSION_MEDIUM` | `allow` (padrão: ações de risco médio rodam direto) · `confirm` |

## 3. Executar

```powershell
python main.py
```

Abre o navegador em **http://127.0.0.1:8000** com a interface conectada.

| Comando | O que faz |
|---|---|
| `python main.py` | servidor + interface (abre o navegador) |
| `python server.py` | o mesmo |
| `python main.py --no-browser` | servidor sem abrir o navegador |
| `python main.py --cli` | conversa pelo terminal, sem interface |
| `python main.py --check` | verifica banco, modelo e ferramentas e sai |

> Abra sempre pelo endereço `http://127.0.0.1:8000`. Abrir o `index.html`
> direto (duplo clique) não conecta ao núcleo — a interface avisa isso.

Mudou o `.env` com o servidor ligado? Use **Sistema → Reiniciar núcleo**
(relê a configuração do modelo) ou reinicie o `python main.py`.

## 4. Testes

```powershell
python -m pytest
```

**173 testes**, sem internet e sem chave (modelo falso + provedores de pesquisa falsos +
HTTP simulado). Leva ~7 s. Cobrem:

| Arquivo | O quê |
|---|---|
| `test_dialogue.py` | o diálogo da fase 3 inteiro (abaixo), com e sem modelo |
| `test_conversation.py` | comandos (pare, continua, volta, repete...), "isso/ele/dele", "a outra opção", assunto que sobrevive a reinício |
| `test_knowledge.py` | base local, canon e separação de universos, grafo, ranking de fontes, conflitos de data, cache, Wikipedia/GitHub/arXiv/Tavily/Brave (HTTP simulado), falhas de rede |
| `test_voice_stream.py` | prosódia, TTS (inclusive indisponível), SSE (estados, deltas, fontes), cancelamento guardando o parcial, planner, etapa de risco que pausa o plano, métricas |
| `test_brain.py` · `test_memory.py` · `test_tools.py` · `test_permissions.py` · `test_api.py` · `test_router.py` · `test_llm.py` | fases 1 e 2 |

O diálogo testado: "JARVIS, quem é Tony Stark?" → "Qual é a relação dele com o Homem-Aranha?"
→ "Qual armadura apareceu primeiro no MCU?" → "Qual é a diferença entre MCU e quadrinhos?"
→ "Pesquise as informações mais recentes." → "Continue." → "Isso foi criado por quem?" → "Pare."

Teste com o modelo real: `python main.py --check` (mostra modelo, pesquisa, base de
conhecimento e voz) e depois converse na aba Conversa.

---

## 4b. Versão web (dentro do claude.ai)

`interface/webcore.js` é o núcleo portado para JavaScript, respondendo às mesmas rotas
`/api/...` (inclusive o streaming). Lá a IA é o Claude do seu plano, a memória fica no
banco privado do artifact e a base de conhecimento vai embutida. **Limites reais da versão
web:** sem internet (pesquisa só na versão local — ele avisa), sem microfone (o navegador
não libera dentro do claude.ai), fala pela voz do navegador. Na versão local o webcore não
é carregado: quem responde é o Python.

## 5. Arquitetura

```
JARVIS/
├── main.py              monta todas as peças (build_jarvis) e inicia servidor / CLI / check
├── server.py            API FastAPI (+ SSE) + entrega da interface
├── config.py            lê o .env, configura logs
├── core/
│   ├── brain.py         orquestra a conversa com streaming e cancelamento
│   ├── conversation.py  CONVERSATION ENGINE: comandos, referências, assunto, memória de curto prazo
│   ├── planner.py       tarefas de várias etapas (até 5, só ferramentas existentes, risco pausa)
│   ├── context.py       prompt: personalidade + situação + memória relevante + resumo + ferramentas
│   ├── metrics.py       tempos reais (1ª palavra, modelo, pesquisa, STT, TTS, total)
│   ├── state.py         estado real + fases IDLE/LISTENING/THINKING/SEARCHING/READING/
│   │                    PROCESSING/SPEAKING/EXECUTING/WAITING_CONFIRMATION/ERROR
│   ├── router.py · memory.py · personality.py · permissions.py · events.py
├── knowledge/           KNOWLEDGE ENGINE
│   ├── __init__.py      decide a fonte, pesquisa em paralelo, cache, conflitos
│   ├── providers.py     Wikipedia · GitHub · arXiv · Tavily · Brave · SiteSearch (domínios oficiais)
│   ├── ranking.py       oficial > documentação > acadêmica > institucional > técnica > mídia > outras
│   ├── reader.py        lê a página e extrai o texto
│   ├── research.py      pesquisa profunda: decompõe → busca → lê → sintetiza com fontes
│   ├── kb.py            base local + grafo de conhecimento (SQLite)
│   ├── universes.py     MCU · Quadrinhos 616 · outras realidades · SSU · outros filmes · animações · jogos
│   ├── cache.py         cache com prazo por tipo (notícia 30 min, Wikipedia 7 dias...)
│   └── marvel_seed.json 31 entidades, 61 fatos, 58 relações (só fatos e metadados — nada de roteiros)
├── voice/
│   ├── prosody.py       frases, pausas e entonação (pergunta sobe, aviso desce...)
│   └── __init__.py · microphone.py · speaker.py
├── models/              llm.py (com stream real) · text_to_speech.py (edge-tts) · speech_to_text.py (Whisper opcional)
├── tools/               calculator · memory · files · knowledge · research · web · projects · system · browser · devices · camera
├── database/migrations/ 001_initial.sql · 002_phase3.sql (base de conhecimento, cache, métricas, resumo da conversa)
├── workspace/           única pasta de arquivos que o JARVIS pode ler/escrever
├── tests/               pytest (173)
└── interface/           index.html · style.css · script.js (+ webcore.js só na versão web)
```

**Como adicionar conhecimento:** crie `knowledge/<tema>_seed.json` no mesmo formato do
`marvel_seed.json` (entidades, fatos com universo/fonte/confiança, relações). Ele é
carregado na próxima inicialização (só quando o arquivo muda).

**Como adicionar uma ferramenta:** crie `tools/minha.py` com uma classe
`Tool` (nome, descrição, parâmetros, risco, `match()` opcional, `execute()`)
e registre em `build_jarvis()` no `main.py`. O router e o modelo passam a vê-la.

**Como adicionar um projeto:** nova linha nas tabelas `projects` /
`project_milestones` (via uma nova migration). A interface lista o que vier
de `GET /api/projects` — hoje, só o JARVIS.

**Como evoluir o banco:** crie `database/migrations/002_algo.sql`. Ela é
aplicada uma única vez na próxima inicialização.

## 6. API

Respostas: `{"success": true, "data": {...}}` ou
`{"success": false, "error": {"code": "...", "message": "..."}}`.
Documentação interativa: http://127.0.0.1:8000/api/docs

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/status` | estado real (`?deep=true` força checar o modelo) |
| POST | `/api/chat` | resposta inteira `{message, conversation_id?, client?}` |
| POST | `/api/chat/stream` | **SSE**: `start · state · delta · sources · tool · plan · step · confirm · done` |
| POST | `/api/chat/cancel` | interrompe a geração `{conversation_id}` (o parcial fica salvo) |
| GET | `/api/chat/history` | histórico com fontes (`?conversation_id=`) |
| POST | `/api/chat/new` | nova conversa |
| GET | `/api/knowledge/status` · `/search?q=` · `/ask?q=` · `/entity/{slug}` | base local e pesquisa |
| GET / POST | `/api/voice/status` · `/api/voice/tts` (áudio mp3) · `/api/voice/plan` · `/api/voice/stt` · `/api/voice/state` | voz |
| GET / POST | `/api/metrics/recent` · `/api/metrics/client` | tempos (observabilidade) |
| GET / POST | `/api/memory` · DELETE `/api/memory/{id}` | memória |
| GET / PATCH | `/api/projects...` | projetos (só o JARVIS) |
| GET | `/api/devices` · `/api/vision/status` · `/api/system/status` | estado real |
| POST | `/api/core/restart` | relê o `.env` e reconecta o modelo |
| GET | `/api/events/recent` · `/api/events/stream` | eventos (SSE) |

`POST`/`PATCH`/`DELETE` exigem o cabeçalho `X-JARVIS-Client` (a interface
envia sozinha). Isso impede que sites abertos no navegador comandem o JARVIS.

## 7. Segurança

- Servidor só em `127.0.0.1`. `POST/PATCH/DELETE` exigem o cabeçalho `X-JARVIS-Client`.
- **Baixo risco roda direto:** pesquisar, calcular, ler memória e arquivos do workspace,
  abrir páginas, resumir, criar arquivo **novo** no workspace.
- **Alto risco sempre pede "sim":** sobrescrever arquivo existente, apagar memória e
  qualquer ação irreversível. Num plano de várias etapas, a etapa de risco **pausa o plano**.
  A confirmação vale 5 minutos e só para aquela conversa.
- Risco médio (abrir programa da lista `ALLOWED_APPS`) segue `PERMISSION_MEDIUM`.
- O modelo não executa comandos livres: só ferramentas registradas, com argumentos validados.
- Arquivos: só dentro de `workspace/`. Páginas lidas: só http/https, até 1,5 MB.
- Microfone (padrão **sempre ouvindo**): o 1º clique liga; depois cada clique **muta/desmuta**.
  Mutar descarta o que estava sendo dito e para a resposta em andamento; desmutar volta para a
  Conversa. O indicador "OUVINDO O TEMPO TODO" / "MUDO" fica sempre visível e o estado é lembrado.
  Outros modos em Configurações → Voz: só reage a "JARVIS…", ou uma frase por clique.
  Esc interrompe resposta e fala a qualquer momento.
- Na versão publicada no claude.ai o navegador **não libera o microfone** (regra do claude.ai);
  o botão explica isso. Para falar, use a versão local no Chrome/Edge.
- Log sem chaves e sem conteúdo de mensagens.

## 8. O que é real e o que ainda não é

| Módulo | Estado |
|---|---|
| Conversa com streaming, interrupção, comandos de conversa, referências | **real** |
| Base de conhecimento (Tony Stark, armaduras, Homem-Aranha...) com universos separados | **real** (curadoria inicial — fatos marcados "confirmar com pesquisa") |
| Pesquisa: Wikipedia, GitHub, arXiv | **real**, sem chave |
| Pesquisa: web geral, notícias, sites oficiais | real **se** houver chave Tavily ou Brave; senão avisa |
| Pesquisa profunda ("pesquise tudo sobre...") | **real** (precisa do modelo para sintetizar) |
| Voz: fala → texto | **real** no Chrome/Edge (serviço do navegador) |
| Voz: texto → fala | **real**: neural (edge-tts, precisa de internet) ou voz do navegador |
| Microfone sempre ouvindo com mudo no clique, interrupção por voz, palavra de ativação | **real** (versão local, Chrome/Edge) |
| Whisper local (`STT_PROVIDER=whisper`) | endpoint `/api/voice/stt` pronto; a interface ainda usa o reconhecimento do navegador — ligar quando houver um PC capaz |
| Métricas (1ª palavra, pesquisa, STT, TTS, total) | **real** — aba Conversa → LATÊNCIA |
| Calculadora, arquivos (workspace), projetos, status do sistema, memória | **real** |
| Smartphone, Axiom Band, Câmera, Óculos AR | **NÃO CONECTADO** |
| Visão | **SINAL ÓPTICO AUSENTE** — simulação na aba Visão é rotulada como fictícia |
| Clima e localização | reais, direto do navegador |

## 9. Fases

1. ✅ Core — backend, API, brain, router, context, personality, LLM
2. ✅ Memória e ferramentas — SQLite, conversas, histórico, interface conectada
3. ✅ Conversa natural — streaming, voz, interrupção, Knowledge Engine, pesquisa com fontes, planner, métricas
4. ⬜ Visão · ⬜ Controle do computador · ⬜ Dispositivos · ⬜ Gestos · ⬜ AR / AXIOM SIGHT
