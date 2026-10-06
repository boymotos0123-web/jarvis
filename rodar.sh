#!/usr/bin/env bash
# Inicia o JARVIS.  Uso:  bash rodar.sh            (servidor + interface)
#                         bash rodar.sh --cli      (conversa no terminal)
#                         bash rodar.sh --check    (verifica a configuração)
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || { echo "Rode primeiro:  bash instalar.sh"; exit 1; }
echo "Abra no Chrome:  http://127.0.0.1:8000   (Ctrl+C para parar)"
exec .venv/bin/python main.py "$@"
