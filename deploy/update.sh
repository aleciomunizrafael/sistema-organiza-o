#!/usr/bin/env bash
# Atualiza o Organiza no VPS: baixa o código novo, instala dependências e reinicia o serviço.
set -euo pipefail
cd /opt/organiza
sudo -u organiza git pull
sudo -u organiza npm install --omit=dev
systemctl restart organiza
sleep 2
systemctl --no-pager --lines=3 status organiza
