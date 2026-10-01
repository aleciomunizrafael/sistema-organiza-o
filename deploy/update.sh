#!/usr/bin/env bash
# Atualiza o Organiza no VPS: baixa o código novo, instala dependências e reinicia o serviço.
set -euo pipefail
cd /opt/organiza
git config --global --add safe.directory /opt/organiza >/dev/null 2>&1 || true
git pull
npm install --omit=dev
chown -R organiza:organiza /opt/organiza
systemctl restart organiza
sleep 2
systemctl --no-pager --lines=3 status organiza
