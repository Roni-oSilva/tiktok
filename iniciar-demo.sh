#!/usr/bin/env bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Instale o Node.js 20 ou 22 LTS: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install || exit 1
echo "SIMULAÇÃO: abra http://127.0.0.1:8787/"
npm run demo
