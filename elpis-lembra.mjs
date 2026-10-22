/* "Elpis lembra": uma dica educativa por dia útil, em rodízio (dicas-elpis.json, editável no GitHub).
   Mesma regra para o Telegram e para o site: a dica depende só da data. Sábado e domingo repetem a de sexta.
   A Elpis explica e lembra; NUNCA recomenda compra ou venda (ficha técnica). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export function dicaDoDia(dataISO, dicas, ancora = '2026-10-19') {
  const lista = dicas || (() => { try { return JSON.parse(fs.readFileSync(path.join(AQUI, 'dicas-elpis.json'), 'utf8')).dicas; } catch (e) { return []; } })();
  if (!lista.length) return '';
  const dias = Math.round((Date.parse(dataISO + 'T12:00:00Z') - Date.parse(ancora + 'T12:00:00Z')) / 86400000);
  const semanas = Math.floor(dias / 7), nodia = Math.min(dias - semanas * 7, 4);   // seg=0 ... sex=4; sáb e dom = sexta
  const i = (((semanas * 5 + nodia) % lista.length) + lista.length) % lista.length;
  return lista[i];
}
/* texto pronto para colocar no fim de uma mensagem do Telegram (vazio se não houver dica) */
export function lembraElpis(dataISO) {
  const d = dicaDoDia(dataISO);
  return d ? '\n\n🌟 Elpis lembra: ' + d : '';
}
