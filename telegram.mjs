/* Aviso diário do Plano B no Telegram: fechamento da bolsa + dólar + Bitcoin.
   Roda no GitHub Actions (.github/workflows/telegram.yml) depois de `node gerar-dados.mjs bolsa-hoje`.
   Variáveis (segredos do repositório):
     TELEGRAM_BOT_TOKEN   token do bot criado no @BotFather
     TELEGRAM_CHAT_ID     id do canal (começa com -100...) ou @nomedocanal
   Opcionais:
     TESTE=1    só mostra a mensagem no log, não envia e não grava o estado
     FORCAR=1   envia mesmo que hoje já tenha sido enviado
   Estado: saida/telegram.json guarda o dia já enviado, para não repetir. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.join(RAIZ, 'saida');
const TESTE = process.env.TESTE === '1';
const FORCAR = process.env.FORCAR === '1';
const API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const AWESOME = process.env.AWESOME_URL || 'https://economia.awesomeapi.com.br/json/last/USD-BRL';
const GECKO = process.env.COINGECKO_URL || 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl,usd&include_24hr_change=true';
const SITE = 'https://planobinvestimentos.com/cotacoes/bolsa/';
const UA = { 'User-Agent': 'PlanoB-Investimentos-aviso/1.0 (uso educacional)' };

const lerJson = (arq) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, arq), 'utf8')); } catch (e) { return null; } };
const pegar = async (url) => {
  const r = await fetch(url, { headers: Object.assign({ Accept: 'application/json' }, UA), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};

/* ---------- formatação em português ---------- */
const num = (v, c = 2) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });
const pct = (v) => (v >= 0 ? '+' : '−') + num(Math.abs(v)) + '%';
const brl = (v, c = 2) => 'R$ ' + num(v, c);
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const dataBR = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

/* hoje em Brasília (UTC-3, sem horário de verão) */
const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T15:00:00Z') : new Date(Date.now() - 3 * 3600 * 1000); // DATA_TESTE=AAAA-MM-DD só para testes
const HOJE = agora.toISOString().slice(0, 10);
const DOW = agora.getUTCDay();
const titulo = (t) => t + ' · ' + DIAS[DOW] + ', ' + dataBR(HOJE);

function linhas(lista, seta, n) {
  const l = (lista || []).slice(0, n);
  return l.length ? seta + ' ' + l.map((x) => x.t + ' ' + pct(x.v)).join(' · ') : '';
}
function grupo(nome, g, n) {
  if (!g || (!(g.altas || []).length && !(g.quedas || []).length)) return '';
  return [nome, linhas(g.altas, '▲', n), linhas(g.quedas, '▼', n)].filter(Boolean).join('\n');
}

/* ---------- blocos da mensagem ---------- */
function blocoBolsa(b) {
  const partes = [];
  if (b.ibov) partes.push('Ibovespa (via BOVA11): ' + pct(b.ibov.v));
  const gs = [grupo('AÇÕES', b.acoes, 5), grupo('FIIs DE TIJOLO', b.fiisTijolo, 3), grupo('FIIs DE PAPEL', b.fiisPapel, 3), grupo('ETFs', b.etfs, 3)].filter(Boolean);
  return (partes.length ? partes.join('\n') + '\n\n' : '') + gs.join('\n\n');
}
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
/* tenta de novo uma vez se o serviço pedir calma (HTTP 429) ou falhar */
async function pegarComRetry(url) {
  try { return await pegar(url); } catch (e) { await dorme(3000); return pegar(url); }
}
/* dólar: 1) AwesomeAPI  2) dólar calculado pelo preço do Bitcoin (BRL ÷ USD)  3) open.er-api.com (atualiza 1x ao dia) */
async function dolar(btc) {
  try {
    const u = (await pegarComRetry(AWESOME)).USDBRL;
    const v = parseFloat(u.bid), p = parseFloat(u.pctChange);
    if (v > 0) return { v, p: isFinite(p) ? p : null, fonte: 'awesomeapi' };
  } catch (e) { console.warn('aviso dólar (AwesomeAPI):', e.message); }
  if (btc && btc.brl > 0 && btc.usd > 0) {
    const v = btc.brl / btc.usd;
    if (v > 2 && v < 20) { console.warn('aviso: dólar calculado pelo Bitcoin.'); return { v, p: null, fonte: 'bitcoin' }; }
  }
  try {
    const j = await pegar(process.env.ER_URL || 'https://open.er-api.com/v6/latest/USD');
    const v = j && j.rates && j.rates.BRL;
    if (v > 0) { console.warn('aviso: dólar da open.er-api.'); return { v, p: null, fonte: 'er-api' }; }
  } catch (e) { console.warn('aviso dólar (open.er-api):', e.message); }
  return null;
}
async function blocoMercado() {
  const l = [];
  let btc = null;
  try {
    const j = await pegarComRetry(GECKO);
    if (j.bitcoin && j.bitcoin.brl > 0) btc = j.bitcoin;
  } catch (e) { console.warn('aviso bitcoin:', e.message); }
  const d = await dolar(btc);
  if (d) l.push('💵 Dólar: ' + brl(d.v) + (d.p !== null ? ' (' + pct(d.p) + ')' : ''));
  if (btc) l.push('₿ Bitcoin: ' + brl(btc.brl, 0) + ' (US$ ' + num(btc.usd, 0) + ')' + (isFinite(btc.brl_24h_change) ? ' · 24h: ' + pct(btc.brl_24h_change) : ''));
  return l;
}
const RODAPE = 'Conteúdo educacional. Não é recomendação de investimento.';

async function enviar(texto) {
  if (TESTE) { console.log('--- MENSAGEM (teste, não enviada) ---\n' + texto + '\n--- fim ---'); return; }
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('faltam os segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
  const r = await fetch(API + '/bot' + token + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram recusou: ' + (j.description || 'HTTP ' + r.status));
  console.log('enviado ao Telegram.');
}
function gravarEstado(e) { if (!TESTE) fs.writeFileSync(path.join(SAIDA, 'telegram.json'), JSON.stringify(e)); }

/* ---------- decide o que enviar ---------- */
const estado = lerJson('telegram.json') || {};
const bolsa = lerJson('bolsa.json');
const temBolsa = !!(bolsa && bolsa.data === HOJE && bolsa.acoes);
const fimDeSemana = DOW === 0 || DOW === 6;
const jaHoje = estado.data === HOJE && !FORCAR;

if (fimDeSemana) {
  if (jaHoje) { console.log('fim de semana: já enviado hoje.'); process.exit(0); }
  const m = await blocoMercado();
  if (!m.length) { console.warn('aviso: sem dados de dólar e Bitcoin; nada enviado.'); process.exit(0); }
  await enviar([titulo('📊 Mercado no fim de semana'), 'A bolsa não abre hoje. Veja como ficaram o dólar (último fechamento) e o Bitcoin:', m.join('\n'), RODAPE].join('\n\n'));
  gravarEstado({ data: HOJE, bolsa: false, tipo: 'fim-de-semana' });
  process.exit(0);
}

if (jaHoje && estado.bolsa) { console.log('dia útil: fechamento completo já enviado hoje.'); process.exit(0); }

if (jaHoje && !estado.bolsa) {
  /* mercado já foi enviado antes; agora só falta a bolsa, se a B3 já liberou os dados */
  if (!temBolsa) { console.log('a B3 ainda não liberou os dados de hoje; tentaremos de novo no próximo horário.'); process.exit(0); }
  await enviar([titulo('📊 Fechamento da bolsa'), blocoBolsa(bolsa), 'Ranking completo: ' + SITE, RODAPE].join('\n\n'));
  gravarEstado({ data: HOJE, bolsa: true, tipo: 'bolsa' });
  process.exit(0);
}

/* primeiro envio do dia útil */
const m = await blocoMercado();
if (temBolsa) {
  await enviar([titulo('📊 Fechamento da bolsa'), blocoBolsa(bolsa), m.join('\n'), 'Ranking completo: ' + SITE, RODAPE].filter(Boolean).join('\n\n'));
  gravarEstado({ data: HOJE, bolsa: true, tipo: 'completo' });
} else {
  if (!m.length) { console.warn('aviso: sem dados de bolsa, dólar e Bitcoin; nada enviado.'); process.exit(0); }
  await enviar([titulo('📊 Mercado hoje'), m.join('\n'), 'Os números de ações, FIIs e ETFs saem assim que a B3 liberar o fechamento.', RODAPE].join('\n\n'));
  gravarEstado({ data: HOJE, bolsa: false, tipo: 'parcial' });
}
