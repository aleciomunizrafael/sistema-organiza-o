#!/usr/bin/env bash
# Backup diário da pasta data/ (banco + sessão do WhatsApp) com o serviço rodando.
# O banco é copiado com ".backup" do sqlite3, que é seguro mesmo em uso.
# Guarda os últimos 14 dias em /opt/organiza/backups.
set -euo pipefail
APP=/opt/organiza
DEST=$APP/backups
STAMP=$(date +%Y-%m-%d_%H%M)
TMP=$(mktemp -d)
mkdir -p "$DEST"
mkdir -p "$TMP/data"
sqlite3 "$APP/data/organiza.db" ".backup '$TMP/data/organiza.db'"
if [ -d "$APP/data/wa-auth" ]; then cp -r "$APP/data/wa-auth" "$TMP/data/"; fi
tar -czf "$DEST/organiza-$STAMP.tar.gz" -C "$TMP" data
rm -rf "$TMP"
find "$DEST" -name 'organiza-*.tar.gz' -mtime +14 -delete
echo "backup salvo em $DEST/organiza-$STAMP.tar.gz"
