/* Manchetes do dia no Telegram (segunda a sexta, 6h50 de Brasília).
   Fonte: feeds RSS da Agência Brasil (agência pública de notícias da EBC), seções Economia e Política: só os títulos, com crédito à fonte.
   Roda no GitHub Actions (.github/workflows/manchetes.yml):  node manchetes.mjs
   Precisa dos segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID.
   Opcionais: TESTE=1 (só mostra no log), FORCAR=1, ECONOMIA=n (padrão 4), POLITICA=n (padrão 3), JANELA_HORAS (padrão 20), DATA_TESTE=AAAA-MM-DD,
   FEED_ECONOMIA, FEED_POLITICA, TELEGRAM_API. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSINATURA_ELPIS } from './elpis-dica.mjs';

const SAIDA = process.env.SAIDA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const TESTE = process.env.TESTE === '1', FORCAR = process.env.FORCAR === '1';
const API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const FEED_ECO = process.env.FEED_ECONOMIA || 'https://agenciabrasil.ebc.com.br/rss/economia/feed.xml';
const FEED_POL = process.env.FEED_POLITICA || 'https://agenciabrasil.ebc.com.br/rss/politica/feed.xml';
const N_ECO = Number(process.env.ECONOMIA) || 4, N_POL = Number(process.env.POLITICA) || 3;
const JANELA = (Number(process.env.JANELA_HORAS) || 20) * 3600 * 1000;
const UA = { 'User-Agent': 'PlanoB-Investimentos-manchetes/1.0 (uso educacional)', Accept: 'application/rss+xml, application/xml, text/xml, */*' };
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T10:00:00Z') : new Date();
const br = new Date(agora.getTime() - 3 * 3600 * 1000);
const HOJE = br.toISOString().slice(0, 10), DOW = br.getUTCDay();
const dataBR = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
const lerJson = (n) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, n), 'utf8')); } catch (e) { return null; } };
const diag = { gerado: new Date().toISOString() };

const ent = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
async function feed(url, nome) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(nome + ': HTTP ' + r.status);
  const xml = await r.text();
  const itens = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map((m) => {
    const b = m[0], get = (t) => { const x = b.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')); return x ? ent(x[1]) : ''; };
    return { titulo: get('title'), data: Date.parse(get('pubDate')), link: get('link') };
  }).filter((x) => x.titulo && Number.isFinite(x.data));
  diag[nome] = { itens: itens.length };
  return itens;
}
const recentes = (l, n) => l.filter((x) => agora.getTime() - x.data <= JANELA && x.data <= agora.getTime() + 3600000).sort((a, b) => b.data - a.data).slice(0, n);
const chave = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function enviar(texto) {
  const corpo = texto + ASSINATURA_ELPIS();
  if (TESTE) { console.log('--- MENSAGEM (teste, não enviada) ---\n' + corpo + '\n--- fim ---'); return; }
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('faltam os segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
  const r = await fetch(API + '/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: corpo, disable_web_page_preview: true }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram recusou: ' + (j.description || 'HTTP ' + r.status));
  console.log('enviado ao Telegram.');
}

try {
  const est = lerJson('manchetes.json') || {};
  if (DOW === 0 || DOW === 6) { if (!FORCAR) { console.log('fim de semana: sem manchetes.'); process.exit(0); } }
  if (est.enviado === HOJE && !FORCAR) { console.log('as manchetes de hoje já foram enviadas.'); process.exit(0); }
  const [eco, pol] = await Promise.all([feed(FEED_ECO, 'economia').catch((e) => { diag.erro_economia = e.message; return []; }), feed(FEED_POL, 'politica').catch((e) => { diag.erro_politica = e.message; return []; })]);
  const vistos = new Set();
  const pega = (l, n) => recentes(l, 30).filter((x) => { const k = chave(x.titulo); if (vistos.has(k)) return false; vistos.add(k); return true; }).slice(0, n);
  const a = pega(eco, N_ECO), b = pega(pol, N_POL);
  diag.enviadas = a.length + b.length;
  fs.writeFileSync(path.join(SAIDA, 'manchetes-diag.json'), JSON.stringify(diag, null, 1));
  if (!a.length && !b.length) { console.warn('sem manchetes recentes nos feeds; nada enviado.', JSON.stringify(diag)); process.exit(1); }
  const lin = (x) => '▪️ ' + x.titulo;
  const msg = ['✍️ MANCHETES DESTA ' + DIAS[DOW].toUpperCase() + (DOW >= 1 && DOW <= 5 ? '-FEIRA' : '') + ', ' + dataBR(HOJE),
    a.length ? '💼 Economia\n' + a.map(lin).join('\n') : '', b.length ? '🏛 Política\n' + b.map(lin).join('\n') : '',
    'Fonte: Agência Brasil (EBC).', 'Conteúdo educacional. Não é recomendação de investimento.'].filter(Boolean).join('\n\n');
  await enviar(msg);
  if (!TESTE) fs.writeFileSync(path.join(SAIDA, 'manchetes.json'), JSON.stringify({ enviado: HOJE }));
} catch (e) { console.error('ERRO:', e.message); try { diag.erro = e.message; fs.writeFileSync(path.join(SAIDA, 'manchetes-diag.json'), JSON.stringify(diag, null, 1)); } catch (x) { /* ignora */ } process.exitCode = 1; }
