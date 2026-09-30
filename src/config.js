import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Carrega .env simples (sem dependência externa)
const envFile = path.join(rootDir, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && process.env[m[1]] === undefined) {
      // Valor entre aspas é literal; sem aspas, remove comentário " # ..." e espaços finais
      const q = m[2].match(/^(["'])(.*)\1$/);
      process.env[m[1]] = q ? q[2] : m[2].replace(/\s+#.*$/, '').trim();
    }
  }
}

// Fuso horário precisa ser definido antes de qualquer uso de Date
if (!process.env.TZ) process.env.TZ = 'America/Sao_Paulo';

const dataDir = path.resolve(rootDir, process.env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT inválida no .env: "${process.env.PORT}" (use um número entre 1 e 65535)`);
}

export const config = {
  rootDir,
  dataDir,
  publicDir: path.join(rootDir, 'public'),
  dbPath: path.join(dataDir, 'organiza.db'),
  waAuthDir: path.join(dataDir, 'wa-auth'),
  port,
  host: process.env.HOST || '0.0.0.0',
  appPassword: process.env.APP_PASSWORD || '',
  appUser: process.env.APP_USER || 'admin',
  waEnabled: !['0', 'false', 'no', 'off', 'nao', 'não'].includes(String(process.env.WA_ENABLED ?? 'true').trim().toLowerCase()),
  logLevel: process.env.LOG_LEVEL || 'info',
  tz: process.env.TZ,
};
