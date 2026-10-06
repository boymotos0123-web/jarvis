#!/usr/bin/env bash
# Instala o JARVIS no Linux (Ubuntu, Debian, Linux do Chromebook).  Uso:  bash instalar.sh
set -e
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null || ! python3 -c "import venv, ensurepip" 2>/dev/null; then
  echo "→ Instalando Python (vai pedir sua senha do Linux)..."
  sudo apt update && sudo apt install -y python3 python3-venv python3-pip
fi
python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" || { echo "✗ Precisa do Python 3.11 ou mais novo (você tem $(python3 --version))."; exit 1; }

echo "→ Criando ambiente virtual (.venv)..."
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip -q
echo "→ Instalando dependências (pode levar alguns minutos)..."
.venv/bin/python -m pip install -r requirements.txt -q

if [ ! -f .env ]; then cp .env.example .env; echo "→ Criei o arquivo .env."; fi

# Chave da IA: se ainda não existe (nem no .env, nem como segredo do Codespaces), pede aqui — não aparece na tela
if [ -z "${API_KEY:-}" ] && grep -qE '^API_KEY=\s*$' .env; then
  echo
  echo "Cole a sua chave do Groq (console.groq.com → API Keys) e aperte Enter."
  echo "(ela não aparece enquanto você cola; fica só no arquivo .env, que nunca vai para o GitHub)"
  read -rs KEY; echo
  if [ -n "$KEY" ]; then
    KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
    sed -i "s|^API_KEY=.*|API_KEY=$KEY|" .env
    echo "→ Chave salva no .env."
  else
    echo "→ Sem chave por enquanto: depois edite o .env (linha API_KEY=)."
  fi
fi

echo "→ Rodando os testes..."
.venv/bin/python -m pytest -q -p no:cacheprovider | tail -1
echo
.venv/bin/python main.py --check 2>/dev/null | grep -E "modelo|pesquisa|voz" || true
echo "✓ Pronto. Para iniciar:  bash rodar.sh"
