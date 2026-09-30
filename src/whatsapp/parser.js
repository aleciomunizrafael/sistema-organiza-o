import { extractDate, extractRecurrence } from '../services/dateParser.js';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Verifica se a mensagem é uma demanda (contém o marcador) e extrai os campos.
 * O marcador pode estar no início, no fim ou em qualquer posição, sem diferenciar
 * maiúsculas. Ex.: "#demanda Revisar contrato até sexta" ou "Revisar contrato #demanda".
 *
 * Retorna null se não for demanda, ou:
 * { title, notes, due_date, recurrence, priority }
 */
export function parseDemand(text, marker = '#demanda', base) {
  if (!text || !marker) return null;
  const markers = marker.split(',').map((m) => m.trim()).filter(Boolean);
  if (!markers.length) return null;

  const re = new RegExp('(^|\\s)(?:' + markers.map(escapeRe).join('|') + ')(?=\\s|$|[:\\-–,.])[:\\-–,.]?', 'i');
  if (!re.test(text)) return null;

  // A linha que contém o marcador é o título ("Bom dia!\n#demanda Revisar contrato" -> "Revisar contrato").
  // Linhas anteriores (saudação) são descartadas; as seguintes viram observações.
  const rawLines = text.split(/\r?\n/);
  const idx = rawLines.findIndex((l) => re.test(l));
  let scoped = text;
  if (idx > 0) {
    const rest = rawLines.slice(idx).join('\n').replace(re, '$1').trim();
    if (rest) scoped = rawLines.slice(idx).join('\n');
  }

  let body = scoped.replace(re, '$1').replace(/[ \t]{2,}/g, ' ').trim();
  if (!body) return null;

  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let title = lines[0] || '';
  const notes = lines.slice(1).join('\n');

  // Prioridade: "urgente" (adjetivo) em qualquer lugar, "!!", ou "prioridade:"/"urgência:" abrindo a frase.
  // "prioridade"/"urgência" no meio do texto são substantivos comuns e não mudam nada.
  let priority = 0;
  const leading = /^(?:(?:urgente|urg[eê]ncia|prioridade|asap|alta\s+prioridade)\s*[:\-–]?\s*)+/i;
  if (leading.test(title) || /\burgente\b/i.test(title) || /\basap\b/i.test(title) || /!{2,}/.test(title)) {
    priority = 1;
    title = title.replace(leading, '').replace(/\b(urgente|asap)\b[:\-]?/gi, '').replace(/!{2,}/g, '').trim();
  }

  const rec = extractRecurrence(title);
  title = rec.cleaned;

  const dt = extractDate(title, base);
  title = dt.cleaned;

  if (!title) title = lines[0].trim();
  // Primeira letra maiúscula
  title = title.charAt(0).toUpperCase() + title.slice(1);

  // Em recorrência, "até <data>" é o fim da repetição; outra preposição é o início
  const isUntil = Boolean(rec.rule && dt.date && dt.isEnd);
  return {
    title,
    notes,
    due_date: rec.rule ? null : dt.date,
    start_date: rec.rule && !isUntil ? dt.date : null,
    recurrence: isUntil ? { ...rec.rule, until: dt.date } : rec.rule,
    priority,
  };
}

/** Texto da mensagem em qualquer um dos formatos comuns do WhatsApp. */
export function extractMessageText(message) {
  if (!message) return '';
  const m = message.ephemeralMessage?.message || message.viewOnceMessage?.message
    || message.documentWithCaptionMessage?.message || message;
  return (
    m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.documentMessage?.caption
    || ''
  ).trim();
}
