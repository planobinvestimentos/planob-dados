/* Assinatura da Elpis no fim das mensagens de TEXTO do Telegram: "🌟 Elpis lembra: <dica do dia>" + convite do grupo.
   A dica é a MESMA do "Elpis lembra" da abertura das 6h e do site (arquivo dicas-elpis.json, editável no GitHub; mesma regra de rodízio:
   uma por dia útil, sábado e domingo repetem a de sexta). Se o dicas-elpis.json não existir, sai só o convite do grupo.
   A Elpis explica e lembra; NUNCA recomenda compra ou venda. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const lerDicas = () => { try { const d = JSON.parse(fs.readFileSync(path.join(AQUI, 'dicas-elpis.json'), 'utf8')).dicas; return Array.isArray(d) ? d.filter(Boolean) : []; } catch (e) { return []; } };
export function indiceDoDia(dataISO, n, ancora = '2026-10-19') {
  if (!n) return 0;
  const dias = Math.round((Date.parse(dataISO + 'T12:00:00Z') - Date.parse(ancora + 'T12:00:00Z')) / 86400000);
  const semanas = Math.floor(dias / 7), nodia = Math.min(dias - semanas * 7, 4);   // seg=0 ... sex=4; sáb e dom = sexta
  return (((semanas * 5 + nodia) % n) + n) % n;
}
const hojeBrasilia = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
export function dicaDoDia(dataISO = hojeBrasilia()) {
  const dicas = lerDicas();
  return dicas.length ? dicas[indiceDoDia(dataISO, dicas.length)] : '';
}
export const CONVITE = '\n\n📲 Participe do nosso grupo do Telegram: @planobinvestimentos';
/* texto que vai no fim da mensagem */
export const ASSINATURA_ELPIS = (dataISO) => { const d = dicaDoDia(dataISO); return (d ? '\n\n🌟 Elpis lembra: ' + d : '') + CONVITE; };
