/* APRESENTAÇÃO DA ELPIS no canal: UMA foto com legenda, enviada uma única vez (estado em saida/elpis-apresentacao.json).
   TESTE=1  -> manda só para o seu Telegram privado (TELEGRAM_ALERTA_CHAT_ID), sem gravar estado.
   FORCAR=1 -> envia ao canal mesmo que já tenha sido enviada.
   FIXAR=1  -> depois de enviar ao canal, tenta fixar a mensagem (o bot precisa ser administrador com permissão de fixar). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = process.env.SAIDA_DIR || path.join(RAIZ, 'saida');
const IMG = path.join(RAIZ, 'imagens', 'elpis-apresentacao.png');
const ARQ = path.join(SAIDA, 'elpis-apresentacao.json');
const API_TG = process.env.TELEGRAM_API || 'https://api.telegram.org';
const TESTE = !!process.env.TESTE, FORCAR = !!process.env.FORCAR, FIXAR = !!process.env.FIXAR;

const LEGENDA = [
  '🌟 Conheça a Elpis!',
  '',
  'Ela é a guia do Plano B no mundo dos investimentos. "Elpis" quer dizer esperança, em grego. Aqui, esperança com método.',
  '',
  'A Elpis vai te ajudar a:',
  '✅ entender ações, FIIs e cripto sem complicação',
  '✅ usar as calculadoras do site',
  '✅ lembrar do que importa: diversificar, planejar e ter paciência',
  '',
  'Ela explica e lembra. Nunca recomenda compra ou venda: tudo aqui é informação, não recomendação.',
  '',
  '👉 planobinvestimentos.com',
].join('\n');

const lerEstado = () => { try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (e) { return {}; } };
const sair = (m) => { console.log(m); process.exit(0); };

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = TESTE ? process.env.TELEGRAM_ALERTA_CHAT_ID : process.env.TELEGRAM_CHAT_ID;
if (!fs.existsSync(IMG)) throw new Error('faltou o arquivo imagens/elpis-apresentacao.png no repositório');
const est = lerEstado();
if (!TESTE && !FORCAR && est.enviado) sair('A apresentação da Elpis já foi enviada em ' + est.enviado + '. Para enviar de novo, rode com "forcar".');
if (TESTE && (!token || !chat)) sair('teste sem TELEGRAM_ALERTA_CHAT_ID: nada enviado.\n' + LEGENDA);
if (!token || !chat) throw new Error('faltam os segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');

const f = new FormData();
f.append('chat_id', chat);
f.append('caption', (TESTE ? '🧪 TESTE (só para você)\n' : '') + LEGENDA);
f.append('photo', new Blob([fs.readFileSync(IMG)], { type: 'image/png' }), 'elpis.png');
const r = await fetch(API_TG + '/bot' + token + '/sendPhoto', { method: 'POST', body: f, signal: AbortSignal.timeout(120000) });
const j = await r.json().catch(() => ({}));
if (!r.ok || !j.ok) throw new Error('Telegram recusou: ' + (j.description || 'HTTP ' + r.status));
console.log('apresentação enviada' + (TESTE ? ' (conversa privada, teste).' : ' ao canal.'));
if (TESTE) process.exit(0);

const id = j.result && j.result.message_id;
let fixada = false;
if (FIXAR && id) {
  try {
    const p = await fetch(API_TG + '/bot' + token + '/pinChatMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, message_id: id, disable_notification: true }), signal: AbortSignal.timeout(30000) });
    const pj = await p.json().catch(() => ({}));
    fixada = !!(p.ok && pj.ok);
    console.log(fixada ? 'mensagem fixada no canal.' : 'não consegui fixar (' + (pj.description || 'HTTP ' + p.status) + '): fixe à mão, tocando e segurando a mensagem.');
  } catch (e) { console.log('não consegui fixar:', e.message); }
}
try { fs.mkdirSync(SAIDA, { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify({ enviado: new Date().toISOString().slice(0, 10), message_id: id || null, fixada }, null, 1)); } catch (e) { console.warn('aviso: não consegui gravar o estado:', e.message); }
