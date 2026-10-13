# JARVIS FPV Sim

Simulador de drone 3D no navegador. Abre em `http://localhost:8000/drone/` com o servidor
do JARVIS rodando (o painel tem o atalho **SIMULADOR FPV** na barra lateral), ou servindo
esta pasta com qualquer servidor estático:

```bash
cd interface/drone && python3 -m http.server 8765   # abra http://localhost:8765
```

Precisa de internet só para baixar o three.js (jsDelivr) e as fontes.

## O que tem

| Área | Detalhe |
|---|---|
| Física | Corpo rígido 6DOF a 400 Hz, inércia por eixo, efeito giroscópico, contatos por impulso (pousa nos pés, capota se bater de lado) |
| Motores | Atraso de rotação (constante de tempo por motor), empuxo ∝ rpm², perda de empuxo com a velocidade de entrada de ar (passo da hélice), torque de reação no yaw |
| Aerodinâmica | Arrasto quadrático por eixo do corpo + arrasto linear dos rotores, efeito solo, **prop wash** ao descer no próprio fluxo, vento com rajadas que aumenta com a altura |
| Bateria | Curva de tensão LiPo por célula, resistência interna (queda de tensão sob carga), consumo por teoria do momento; o drone perde força no fim da bateria |
| Controladora | PID de taxa em cascata no estilo Betaflight: D na medida, feedforward, anti-windup, airmode, mixer com saturação proporcional e prioridade de roll/pitch sobre yaw |
| Modos | **ACRO** (taxa), **ANGLE** (auto-nivelado), **GPS** (segura posição e altitude, pouso assistido) |
| Rates | RC Rate / Super Rate / Expo por eixo, com a mesma fórmula do Betaflight |
| Aeronaves | Freestyle 5" (6S), Long Range 7", Cinewhoop 3", FPV com dutos estilo Avata, Câmera 900 g estilo Air, Mini 249 g, Tiny Whoop 65 mm |
| Cenário | Campo de corrida, cidade com 60 prédios (vidro, escritórios, residenciais), ruas e postes, lago (cair na água derruba), bosques, montanhas, nuvens, grama, ciclo dia/noite com janelas acesas |
| Câmeras | FPV com uptilt e FOV ajustáveis, perseguição, visada do piloto (zoom automático), órbita livre |
| Vídeo | Digital HD ou analógico (ruído por distância e obstrução, scanlines, chuvisco no crash) |
| OSD | Modo, LQ, tensão/célula/corrente/mAh, cronômetro, horizonte artificial, altitude, vario, velocidade, acelerador, G, seta para home/objetivo, alertas |
| Atividades | Voo livre · Corrida (12 portais, 3 voltas, melhor volta salva) · Pouso de precisão (chão, telhado de container, topo da torre) |
| Ferramentas | Replay dos últimos 40 s, blackbox ao vivo (setpoint × gyro e motores), minimapa |
| Foto e vídeo | Foto em 2× a resolução da tela (JPG), gravação de vídeo com som dos motores (MP4 ou WebM, sem o OSD), gravação do replay, galeria guardada no navegador |
| Cinema | Modo Cine (lento e suave), gimbal ajustável (Q/E, roda do mouse ou gatilhos), voos automáticos Dronie, Órbita e Foguete com gravação automática, esconder HUD |
| Controles | Teclado, gamepad, **rádio RC via USB** (EdgeTX/OpenTX em modo joystick) com detecção de eixos, e sticks de toque no celular |

## Mundo Real (cidades reais em 3D)

A atividade **Mundo real** carrega o Google Photorealistic 3D Tiles: Rio, São Paulo, Brasília,
Nova York, Paris, Dubai, Tóquio, Grand Canyon ou qualquer latitude/longitude.

1. Em [console.cloud.google.com](https://console.cloud.google.com), crie um projeto com faturamento ativo.
2. Ative a **Map Tiles API** e crie uma chave de API em Credenciais.
3. Restrinja a chave ao endereço onde você abre o simulador (ex.: `http://localhost:8000/*`).
4. Cole a chave na tela inicial do simulador (fica salva só no seu navegador).

Cada voo conta como uma sessão; as primeiras 1.000 do mês são grátis. A colisão usa raios
lançados contra a malha real em volta do drone. O modo **não funciona no link publicado no
Claude** (a página de lá bloqueia o acesso aos servidores do Google): rode pelo JARVIS ou com
`python3 -m http.server`.

## Comandos

| Tecla | Ação |
|---|---|
| W / S | Acelerador (no modo GPS: subir / descer) |
| A / D | Yaw |
| ↑ / ↓ | Pitch |
| ← / → | Roll |
| Espaço | Armar / desarmar (acelerador embaixo) |
| R | Reiniciar |
| C | Trocar câmera |
| M | Trocar modo de voo |
| T | Replay |
| B / N | Blackbox / minimapa |
| V | Vídeo digital / analógico |
| P / G | Foto / gravar vídeo |
| O | Galeria |
| Z | Modo Cine |
| Q / E | Gimbal para baixo / para cima (drone de câmera) |
| 1 / 2 / 3 | Dronie / Órbita / Foguete |
| H | Esconder HUD |
| Esc | Menu e configurações |

Gamepad: A armar · B reset · X modo · Y câmera · Start menu · LB foto · RB gravar · gatilhos gimbal. Rádio: escolha o perfil
"Rádio RC (AETR)" em Menu → Controles e use **Detectar** em cada canal; armar pode ser uma chave.

## Arquivos

| Arquivo | Papel |
|---|---|
| `sim.js` | Física, bateria e controladora de voo (sem dependência de renderização) |
| `world.js` | Terreno, colisões, pista, prédios, árvores e alvos (determinístico pela semente) |
| `app.js` | Renderização three.js, entrada, OSD, áudio, corrida, replay, voos automáticos e menus |
| `media.js` | Fotos, gravação de vídeo e galeria (IndexedDB) |
| `scenery.js` | Cidade, ruas, postes, lago com reflexo, nuvens e grama |
| `post.js` | Pós-processamento: bloom, lente grande-angular, reflexo do sol |
| `realworld.js` / `places.js` | Modo Mundo Real (Google 3D Tiles) e lugares prontos |
| `index.html` | Página, estilos e import map |

Testes da física: `node --test tests/drone_sim.test.mjs` (na raiz do repositório).
