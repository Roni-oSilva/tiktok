#!/usr/bin/env bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Instale o Node.js 20 ou 22 LTS: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install || exit 1
if [ ! -f .env ]; then read -r -p "Seu @usuario do TikTok (a live precisa estar ligada): " U; echo "TIKTOK_USERNAME=$U" > .env; fi
echo "AO VIVO: cena em http://127.0.0.1:8787/ (fonte de navegador 1080x1920)"
npm run live
