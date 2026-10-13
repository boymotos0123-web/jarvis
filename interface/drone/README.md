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
| Aeronaves | Freestyle 5" (6S), Cinewhoop 3" (4S), Câmera estilo DJI (3S, gimbal), Tiny Whoop 65 mm (1S) |
| Câmeras | FPV com uptilt e FOV ajustáveis, perseguição, visada do piloto (zoom automático), órbita livre |
| Vídeo | Digital HD ou analógico (ruído por distância e obstrução, scanlines, chuvisco no crash) |
| OSD | Modo, LQ, tensão/célula/corrente/mAh, cronômetro, horizonte artificial, altitude, vario, velocidade, acelerador, G, seta para home/objetivo, alertas |
| Atividades | Voo livre · Corrida (12 portais, 3 voltas, melhor volta salva) · Pouso de precisão (chão, telhado de container, topo da torre) |
| Ferramentas | Replay dos últimos 40 s, blackbox ao vivo (setpoint × gyro e motores), minimapa |
| Controles | Teclado, gamepad, **rádio RC via USB** (EdgeTX/OpenTX em modo joystick) com detecção de eixos, e sticks de toque no celular |

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
| Esc | Menu e configurações |

Gamepad: A armar · B reset · X modo · Y câmera · Start menu. Rádio: escolha o perfil
"Rádio RC (AETR)" em Menu → Controles e use **Detectar** em cada canal; armar pode ser uma chave.

## Arquivos

| Arquivo | Papel |
|---|---|
| `sim.js` | Física, bateria e controladora de voo (sem dependência de renderização) |
| `world.js` | Terreno, colisões, pista, prédios, árvores e alvos (determinístico pela semente) |
| `app.js` | Renderização three.js, entrada, OSD, áudio, corrida, replay e menus |
| `index.html` | Página, estilos e import map |

Testes da física: `node --test tests/drone_sim.test.mjs` (na raiz do repositório).
