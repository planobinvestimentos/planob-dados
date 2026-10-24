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
/* sexta-feira: o último fechamento da semana termina com o desejo de bom final de semana */
export const DESEJO_SEXTA = '🌟 A Elpis deseja a todos um ótimo final de semana! Voltamos com força total na segunda-feira. 💪';
export const ehSexta = (dataISO) => new Date(dataISO + 'T12:00:00Z').getUTCDay() === 5;
/* Elpis em imagem: o "Elpis lembra" do resumo do dia sai como foto, com a dica na legenda. Há 5 artes (imagens/elpis-lembra-1.jpg a -5.jpg),
   em rodízio durante a semana: segunda = 1, terça = 2 ... sexta = 5 (sábado e domingo repetem a de sexta, como a dica). Se quiser mais artes, basta
   subir elpis-lembra-6.jpg, 7... (até 9): o rodízio passa a contar com elas. Sem nenhuma imagem no repositório, o envio cai no texto de sempre. */
export const fotosElpis = () => { const o = []; for (let n = 1; n <= 9; n++) { const f = path.join(AQUI, 'imagens', 'elpis-lembra-' + n + '.jpg'); try { if (fs.statSync(f).size > 1000) o.push(f); } catch (e) { /* não existe */ } } return o; };
export const temFotoElpis = () => fotosElpis().length > 0;
export const fotoDoDia = (dataISO = hojeBrasilia()) => { const l = fotosElpis(); return l.length ? l[indiceDoDia(dataISO, l.length)] : ''; };
export async function enviarFotoElpis({ token, chat, api = 'https://api.telegram.org', dataISO, teste = false } = {}) {
  const arq = fotoDoDia(dataISO);
  if (!arq) throw new Error('nenhuma imagem elpis-lembra-N.jpg no repositório');
  const legenda = ASSINATURA_ELPIS(dataISO).trim().slice(0, 1000);
  if (teste) { console.log('--- FOTO DA ELPIS (teste, não enviada): ' + path.basename(arq) + ' ---\n' + legenda + '\n--- fim ---'); return; }
  const fd = new FormData();
  fd.append('chat_id', chat);
  fd.append('caption', legenda);
  fd.append('disable_notification', 'true');
  fd.append('photo', new Blob([fs.readFileSync(arq)], { type: 'image/jpeg' }), path.basename(arq));
  const r = await fetch(api + '/bot' + token + '/sendPhoto', { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram recusou a foto: ' + (j.description || 'HTTP ' + r.status));
  console.log('foto da Elpis (' + path.basename(arq) + ') enviada ao Telegram.');
}
export const ASSINATURA_ELPIS = (dataISO) => { const d = dicaDoDia(dataISO); return (d ? '\n\n🌟 Elpis lembra: ' + d : '') + CONVITE; };
