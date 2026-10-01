#!/usr/bin/env bash
# Instala o Organiza em um VPS Ubuntu 22.04/24.04 (ou Debian 12) limpo.
#
# Uso (como root, no VPS):
#   curl -fsSL https://raw.githubusercontent.com/aleciomunizrafael/sistema-organiza-o/main/deploy/install-vps.sh -o install.sh
#   bash install.sh organiza.seudominio.com.br "sua-senha-forte"
#
# O que faz: instala Node 22, Caddy (HTTPS automático) e sqlite3; cria o usuário
# de serviço; clona o projeto em /opt/organiza; grava o .env com a senha; cria o
# serviço systemd (religa sozinho); configura o firewall (22, 80, 443) e um backup
# diário às 03:00 em /opt/organiza/backups.
set -euo pipefail

DOMAIN="${1:-}"
PASSWORD="${2:-}"
REPO="${REPO:-https://github.com/aleciomunizrafael/sistema-organiza-o.git}"
BRANCH="${BRANCH:-main}"
APP=/opt/organiza

if [ -z "$DOMAIN" ] || [ -z "$PASSWORD" ]; then
  echo "Uso: bash install.sh <dominio> <senha-do-app>"
  echo "Ex.: bash install.sh organiza.seudominio.com.br 'minha senha forte'"
  echo "Sem domínio próprio, crie um grátis em https://www.duckdns.org (ex.: meuorganiza.duckdns.org) apontando para o IP deste VPS."
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then echo "Execute como root (sudo bash install.sh ...)"; exit 1; fi

echo "==> Memória de troca (swap) em servidores pequenos"
if [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 1500 ] && [ "$(swapon --show | wc -l)" -eq 0 ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap de 1 GB criado"
fi

echo "==> Pacotes básicos"
rm -f /etc/apt/sources.list.d/caddy-stable.list /usr/share/keyrings/caddy-stable-archive-keyring.gpg  # repositório do Caddy com chave expirada
apt-get update -y
apt-get install -y curl git sqlite3 ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "==> Node.js 22"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> Caddy (HTTPS automático)"
install_caddy_apt() {
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg || return 1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list || return 1
  apt-get update -y && apt-get install -y caddy
}
install_caddy_binary() {
  # Alternativa: binário oficial + serviço systemd
  local arch; arch=$(dpkg --print-architecture)
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${arch}" -o /usr/bin/caddy || return 1
  chmod +x /usr/bin/caddy
  groupadd --system caddy 2>/dev/null || true
  id -u caddy >/dev/null 2>&1 || useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
  mkdir -p /etc/caddy
  cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
After=network.target network-online.target
Requires=network-online.target
[Service]
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable caddy >/dev/null
}
# O repositório apt do Caddy teve problemas de chave; o binário oficial é mais confiável.
if ! command -v caddy >/dev/null; then
  install_caddy_binary || { echo "binário indisponível; tentando o repositório apt"; install_caddy_apt; }
fi
command -v caddy >/dev/null || { echo "ERRO: não foi possível instalar o Caddy"; exit 1; }
mkdir -p /etc/caddy
caddy version

echo "==> Usuário de serviço e código"
id -u organiza >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin organiza
if [ -d "$APP/.git" ]; then
  git -C "$APP" pull
else
  git clone -b "$BRANCH" "$REPO" "$APP"
fi
cd "$APP"
npm install --omit=dev
mkdir -p data logs backups

if [ ! -f .env ]; then
  cat > .env <<ENV
PORT=3000
HOST=127.0.0.1
DATA_DIR=data
TZ=America/Sao_Paulo
APP_USER=admin
APP_PASSWORD="$PASSWORD"
WA_ENABLED=true
LOG_LEVEL=info
ENV
fi
chown -R organiza:organiza "$APP"
chmod 600 .env

echo "==> Serviço systemd"
cp deploy/organiza.service /etc/systemd/system/organiza.service
systemctl daemon-reload
systemctl enable --now organiza
sleep 2
systemctl --no-pager --lines=5 status organiza || true

echo "==> Caddy para $DOMAIN"
sed "s/__DOMAIN__/$DOMAIN/" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
sleep 2
systemctl --no-pager --lines=3 status caddy || true

echo "==> Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | head -8

echo "==> Backup diário (03:00)"
chmod +x deploy/backup.sh
cat > /etc/cron.d/organiza-backup <<CRON
0 3 * * * organiza /opt/organiza/deploy/backup.sh >> /opt/organiza/logs/backup.log 2>&1
CRON

echo
echo "Pronto. Abra https://$DOMAIN (usuário: admin, senha: a que você informou)."
echo "Depois: Configurações -> Reconectar / gerar QR -> escaneie com o WhatsApp -> escolha o grupo -> Salvar."
echo "Comandos úteis: systemctl status organiza | journalctl -u organiza -f | bash /opt/organiza/deploy/update.sh"
