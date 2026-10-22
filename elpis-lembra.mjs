/* "Elpis lembra": uma dica educativa por dia útil, em rodízio (dicas-elpis.json, editável no GitHub), enviada como
   FIGURINHA da Elpis (fundo transparente, imagens/elpis-lembra-1.webp ... N.webp) + dica em texto, logo depois da mensagem da abertura das 6h.
   Mesma regra para o Telegram e para o site: a dica depende só da data. Sábado e domingo repetem a de sexta.
   A Elpis explica e lembra; NUNCA recomenda compra ou venda (ficha técnica). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const lerDicas = () => { try { return JSON.parse(fs.readFileSync(path.join(AQUI, 'dicas-elpis.json'), 'utf8')).dicas || []; } catch (e) { return []; } };
export function indiceDoDia(dataISO, n, ancora = '2026-10-19') {
  if (!n) return 0;
  const dias = Math.round((Date.parse(dataISO + 'T12:00:00Z') - Date.parse(ancora + 'T12:00:00Z')) / 86400000);
  const semanas = Math.floor(dias / 7), nodia = Math.min(dias - semanas * 7, 4);   // seg=0 ... sex=4; sáb e dom = sexta
  return (((semanas * 5 + nodia) % n) + n) % n;
}
export function dicaDoDia(dataISO, dicas) {
  const lista = dicas || lerDicas();
  return lista.length ? lista[indiceDoDia(dataISO, lista.length)] : '';
}
/* texto simples (sem foto), caso precise colar no fim de alguma mensagem */
export function lembraElpis(dataISO) {
  const d = dicaDoDia(dataISO);
  return d ? '\n\n🌟 Elpis lembra: ' + d : '';
}
/* Envia a Elpis como FIGURINHA (fundo transparente) e, logo depois, a dica em texto.
   Telegram não aceita foto com fundo transparente nem legenda em figurinha, por isso são 2 mensagens.
   Nunca derruba o programa: se algo falhar, só avisa no log. */
export async function enviarLembra({ dataISO, token, chat, api = 'https://api.telegram.org', prefixo = '', teste = false }) {
  try {
    const dicas = lerDicas(); if (!dicas.length) return;
    const dica = dicas[indiceDoDia(dataISO, dicas.length)];
    const texto = (prefixo + '🌟 Elpis lembra: ' + dica).slice(0, 3900);
    const dirImg = path.join(AQUI, 'imagens');
    const figs = fs.existsSync(dirImg) ? fs.readdirSync(dirImg).filter((f) => /^elpis-lembra-\d+\.webp$/.test(f)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)) : [];
    const fig = figs.length ? figs[indiceDoDia(dataISO, dicas.length) % figs.length] : null;
    if (teste) { console.log('--- ELPIS LEMBRA (teste, não enviada) ---\n[figurinha: ' + (fig || 'nenhuma') + ']\n' + texto + '\n--- fim ---'); return; }
    if (!token || !chat) { console.warn('aviso (Elpis lembra): sem token/chat.'); return; }
    if (fig) {
      try {
        const f = new FormData();
        f.append('chat_id', chat);
        f.append('sticker', new Blob([fs.readFileSync(path.join(dirImg, fig))], { type: 'image/webp' }), fig);
        const r = await fetch(api + '/bot' + token + '/sendSticker', { method: 'POST', body: f, signal: AbortSignal.timeout(30000) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) console.warn('aviso (Elpis lembra): figurinha recusada: ' + (j.description || 'HTTP ' + r.status));
        else console.log('Elpis lembra: figurinha ' + fig + ' enviada.');
      } catch (e) { console.warn('aviso (Elpis lembra): figurinha falhou:', e.message); }
    }
    const r2 = await fetch(api + '/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true }), signal: AbortSignal.timeout(20000) });
    const j2 = await r2.json().catch(() => ({}));
    if (!r2.ok || !j2.ok) console.warn('aviso (Elpis lembra): Telegram recusou o texto: ' + (j2.description || 'HTTP ' + r2.status));
    else console.log('Elpis lembra: dica enviada.');
  } catch (e) { console.warn('aviso (Elpis lembra):', e.message); }
}
