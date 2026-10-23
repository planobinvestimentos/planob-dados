/* Abertura dos mercados no Telegram (dias úteis).
   Roda no GitHub Actions (.github/workflows/abertura.yml). Duas partes:
     node abertura.mjs manha     6h  - principais indicadores lá fora (EUA futuros, Europa, Ásia-Pacífico, commodities,
                                       minério de Dalian, Bitcoin) + extras (VIX, EWZ, Vale, Petrobras, dólar, Ibovespa)
     node abertura.mjs futuros   9h10 - futuros brasileiros da B3 (Ibovespa e dólar), que só abrem às 9h
   Fontes do mercado de fora, sem chave, nesta ordem: CNBC, Yahoo Finance, Stooq. Cada item usa a primeira que responder.
   Minério de ferro: Sina (Dalian), Eastmoney (Dalian) e, por último, Yahoo (Cingapura).
   Se uma fonte mudar ou bloquear o GitHub, o item some da mensagem (nunca aparece número inventado) e o
   arquivo saida/abertura-diag.json mostra o que funcionou.
   Variáveis (segredos): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.   Opcionais: TESTE=1 (só mostra no log), FORCAR=1. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSINATURA_ELPIS } from './elpis-dica.mjs';

const SAIDA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const MODO = process.argv[2] || process.env.MODO || 'manha';
const TESTE = process.env.TESTE === '1', FORCAR = process.env.FORCAR === '1';
const API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const B3 = process.env.B3_COTACAO_URL || 'https://cotacao.b3.com.br/mds/api/v1/instrumentQuotation/';
const CNBC = process.env.CNBC_URL || 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
const YAHOO = (process.env.YAHOO_URL || 'https://query1.finance.yahoo.com,https://query2.finance.yahoo.com').split(',');
const STOOQ = process.env.STOOQ_URL || 'https://stooq.com/q/d/l/';
const SINA = process.env.SINA_URL || 'https://hq.sinajs.cn/list=';
const EASTMONEY = process.env.EASTMONEY_URL || 'https://push2.eastmoney.com/api/qt/stock/get';
const GECKO = process.env.COINGECKO_URL || 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; PlanoB-Investimentos-aviso/1.0; uso educacional)', Accept: 'application/json, text/csv, */*' };
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const lerJson = (arq) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, arq), 'utf8')); } catch (e) { return null; } };

/* ---------- formatação ---------- */
const num = (v, c = 2) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });
const pct = (v) => (Math.abs(v) < 0.005 ? '0,00%' : (v > 0 ? '+' : '−') + num(Math.abs(v)) + '%');
const sinal = (v) => (!isFinite(v) ? '▫️' : v > 0.005 ? '🟢' : v < -0.005 ? '🔻' : '⚪');
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T10:00:00Z') : new Date(Date.now() - 3 * 3600 * 1000); // Brasília
const HOJE = agora.toISOString().slice(0, 10), DOW = agora.getUTCDay();
const coletadoAs = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(11, 16); // hora de Brasília em que os dados foram buscados
const dataBR = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
const numero = (s) => { const v = parseFloat(String(s == null ? '' : s).replace(/[%,\s]/g, '')); return Number.isFinite(v) ? v : NaN; };

/* ---------- rede ---------- */
async function pegar(url, { json = true, ms = 15000, tentativas = 2, headers = {} } = {}) {
  let erro;
  for (let t = 0; t < tentativas; t++) {
    try {
      const r = await fetch(url, { headers: Object.assign({}, UA, headers), signal: AbortSignal.timeout(ms) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      return json ? JSON.parse(txt) : txt;
    } catch (e) { erro = e; await dorme(700); }
  }
  throw erro;
}

/* ---------- B3: Ibovespa, mini índice e mini dólar futuros ---------- */
const LETRA = 'FGHJKMNQUVXZ';
function quartaProxima15(ano, mes) { // vencimento do futuro de Ibovespa: quarta-feira mais próxima do dia 15
  const d = new Date(Date.UTC(ano, mes, 15));
  const delta = (3 - d.getUTCDay() + 7) % 7;
  return new Date(d.getTime() + (delta <= 3 ? delta : delta - 7) * 86400000);
}
export function contratoWin(hoje) {      // meses pares: G J M Q V Z
  const ano = hoje.getUTCFullYear(), mes = hoje.getUTCMonth();
  for (let i = 0; i < 14; i++) {
    const m = (mes + i) % 12, a = ano + Math.floor((mes + i) / 12);
    if (m % 2 === 1 && quartaProxima15(a, m) > hoje) return 'WIN' + LETRA[m] + String(a).slice(2);
  }
  return null;
}
export function contratoWdo(hoje) {      // mini dólar: todo mês, vence no 1º dia útil; o "da vez" é o do mês seguinte
  const m = (hoje.getUTCMonth() + 1) % 12, a = hoje.getUTCFullYear() + (hoje.getUTCMonth() === 11 ? 1 : 0);
  return 'WDO' + LETRA[m] + String(a).slice(2);
}
async function cotacaoB3(tk) {
  const j = await pegar(B3 + tk);
  const q = j && j.Trad && j.Trad[0] && j.Trad[0].scty && j.Trad[0].scty.SctyQtn;
  if (!q || !(q.curPrc > 0)) throw new Error('sem cotação para ' + tk);
  return { t: tk, p: q.curPrc, v: Number(q.prcFlcn) };
}

/* ---------- mercado de fora: itens com o código em cada fonte ---------- */
const I = (id, n, o) => Object.assign({ id, n }, o);
const GRUPOS = [
  { t: '🇺🇸 EUA (futuros)', itens: [
    I('ymf', 'Dow Jones Futuro', { c: '@YM.1', y: 'YM=F', s: 'ym.f' }),
    I('esf', 'S&P 500 Futuro', { c: '@ES.1', y: 'ES=F', s: 'es.f' }),
    I('nqf', 'Nasdaq Futuro', { c: '@NQ.1', y: 'NQ=F', s: 'nq.f' })] },
  { t: '🇪🇺 Europa', itens: [
    I('stoxx', 'STOXX 600', { c: '.STOXX', y: '^STOXX' }),
    I('dax', 'DAX (Alemanha)', { c: '.GDAXI', y: '^GDAXI', s: '^dax' }),
    I('ftse', 'FTSE 100 (Reino Unido)', { c: '.FTSE', y: '^FTSE', s: '^ukx' }),
    I('cac', 'CAC 40 (França)', { c: '.FCHI', y: '^FCHI', s: '^cac' }),
    I('ftmib', 'FTSE MIB (Itália)', { c: '.FTMIB', y: 'FTSEMIB.MI' })] },
  { t: '🌏 Ásia-Pacífico', itens: [
    I('ssec', 'Shanghai SE (China)', { c: '.SSEC', y: '000001.SS', s: '^shc' }),
    I('n225', 'Nikkei (Japão)', { c: '.N225', y: '^N225', s: '^nkx' }),
    I('hsi', 'Hang Seng (Hong Kong)', { c: '.HSI', y: '^HSI', s: '^hsi' }),
    I('nifty', 'Nifty 50 (Índia)', { c: '.NSEI', y: '^NSEI' }),
    I('asx', 'ASX 200 (Austrália)', { c: '.AXJO', y: '^AXJO' })] },
  { t: '🛢️ Commodities', itens: [
    I('wti', 'Petróleo WTI', { c: '@CL.1', y: 'CL=F', s: 'cl.f', barril: true }),
    I('brent', 'Petróleo Brent', { c: '@LCO.1', y: 'BZ=F', s: 'cb.f', barril: true })] },   // o minério entra aqui (fonte própria)
  { t: '🪙 Criptos', itens: [
    I('btc', 'Bitcoin', { y: 'BTC-USD', s: 'btc.v', btc: true })] },
  { t: '➕ Extras', itens: [
    I('vix', 'VIX (índice do medo)', { c: '.VIX', y: '^VIX', s: '^vix', ex: 'idx' }),
    I('ewz', 'EWZ (ETF do Brasil, EUA)', { c: 'EWZ', y: 'EWZ', s: 'ewz.us', ex: 'usd' }),
    I('vale', 'Vale (NYSE)', { c: 'VALE', y: 'VALE', ex: 'usd' }),
    I('pbr', 'Petrobras (NYSE)', { c: 'PBR', y: 'PBR', ex: 'usd' }),
    I('dxy', 'Dólar no mundo (DXY)', { c: '.DXY', y: 'DX-Y.NYB', s: 'dx.f', ex: 'idx' }),
    I('usdbrl', 'Dólar em reais', { c: 'BRL=', y: 'BRL=X', s: 'usdbrl', ex: 'brl' })] },
];
const OCULTOS = [I('usdcny', 'Dólar em iuanes', { c: 'CNY=', y: 'CNY=X', s: 'usdcny' }), I('tio', 'Minério de ferro (Cingapura)', { y: 'TIO=F' })];
const TODOS = GRUPOS.flatMap((g) => g.itens).concat(OCULTOS);

async function viaCoinGecko(got, diag) {
  try {
    const j = await pegar(GECKO, { tentativas: 2 });
    const b = j && j.bitcoin;
    if (b && b.usd > 0 && isFinite(b.usd_24h_change)) { got.btc = { p: b.usd, v: b.usd_24h_change, fonte: 'coingecko' }; diag.coingecko = 'ok'; }
  } catch (e) { diag.coingecko = 'erro: ' + e.message; }
}
async function viaCnbc(itens, got, diag) {
  const lista = itens.filter((i) => i.c && !got[i.id]);
  if (!lista.length) return;
  const url = CNBC + '?symbols=' + lista.map((i) => encodeURIComponent(i.c)).join('|') + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1';
  try {
    const j = await pegar(url);
    let q = j && j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote; q = Array.isArray(q) ? q : q ? [q] : [];
    for (const r of q) {
      const it = lista.find((i) => i.c.toUpperCase() === String(r.symbol || '').toUpperCase());
      if (!it || got[it.id]) continue;
      const ext = r.ExtendedMktQuote && numero(r.ExtendedMktQuote.last) > 0 ? r.ExtendedMktQuote : null;   // pré-mercado, quando houver
      const p = numero(ext ? ext.last : r.last), prev = numero(r.previous_day_closing);
      let v = ext ? numero(ext.change_pct) : numero(r.change_pct);
      if (!isFinite(v) && p > 0 && prev > 0) v = (p / prev - 1) * 100;
      if (p > 0 && isFinite(v)) got[it.id] = { p, v, fonte: 'cnbc' + (ext ? '-pre' : '') };
    }
    diag.cnbc = 'ok: ' + q.length + ' itens';
  } catch (e) { diag.cnbc = 'erro: ' + e.message; }
}
async function viaYahoo(itens, got, diag) {
  let ok = 0, erro = '';
  for (const it of itens) {
    if (got[it.id] || !it.y) continue;
    for (const h of YAHOO) {
      try {
        const j = await pegar(h + '/v8/finance/chart/' + encodeURIComponent(it.y) + '?range=1d&interval=1d&includePrePost=true', { tentativas: 1, ms: 10000 });
        const m = j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
        const p = m && m.regularMarketPrice, prev = m && (m.chartPreviousClose || m.previousClose);
        if (p > 0 && prev > 0) { got[it.id] = { p, v: (p / prev - 1) * 100, fonte: 'yahoo' }; ok++; break; }
      } catch (e) { erro = e.message; }
    }
    await dorme(150);
  }
  diag.yahoo = ok + ' ok' + (erro ? ' (último erro: ' + erro + ')' : '');
}
async function viaStooq(itens, got, diag) {
  let ok = 0, erro = '';
  for (const it of itens) {
    if (got[it.id] || !it.s) continue;
    try {
      const csv = await pegar(STOOQ + '?s=' + encodeURIComponent(it.s) + '&i=d', { json: false, tentativas: 1, ms: 12000 });
      const l = csv.trim().split(/\r?\n/).filter((x) => /^\d{4}-\d{2}-\d{2}/.test(x)).slice(-2).map((x) => x.split(','));
      if (l.length === 2) { const p = numero(l[1][4]), prev = numero(l[0][4]); if (p > 0 && prev > 0) { got[it.id] = { p, v: (p / prev - 1) * 100, fonte: 'stooq' }; ok++; } }
    } catch (e) { erro = e.message; }
    await dorme(150);
  }
  diag.stooq = ok + ' ok' + (erro ? ' (último erro: ' + erro + ')' : '');
}

/* ---------- minério de ferro: bolsa de Dalian (China), em iuanes ---------- */
const faixaMinerio = (p) => p > 300 && p < 3000;
async function minerioDalian(diag) {
  const erros = [];
  /* 1) Sina: contrato principal contínuo (I0). Campos: 8 = último, 10 = liquidação anterior */
  try {
    const txt = await pegar(SINA + 'nf_I0', { json: false, tentativas: 2, headers: { Referer: 'https://finance.sina.com.cn' } });
    const m = txt.match(/="([^"]*)"/);
    const f = m ? m[1].split(',') : [];
    const p = numero(f[8]), prev = numero(f[10]);
    if (faixaMinerio(p) && prev > 0) { diag.minerio = 'sina'; return { p, v: (p / prev - 1) * 100, moeda: 'CNY', fonte: 'sina' }; }
    erros.push('sina: resposta fora do padrão (' + String(txt).slice(0, 80).replace(/\s+/g, ' ') + ')');
  } catch (e) { erros.push('sina: ' + e.message); }
  /* 2) Eastmoney: contratos de janeiro, maio e setembro (os mais negociados) */
  try {
    const ano = agora.getUTCFullYear(), mes = agora.getUTCMonth() + 1, cand = [];
    for (let a = ano; a <= ano + 1 && cand.length < 3; a++) for (const m of [1, 5, 9]) if (a > ano || m >= mes) cand.push('i' + String(a).slice(2) + String(m).padStart(2, '0'));
    for (const cod of cand) {
      const j = await pegar(EASTMONEY + '?secid=114.' + cod + '&fields=f43,f60,f170&fltt=2&invt=2', { tentativas: 1 });
      const d = j && j.data, p = numero(d && d.f43), prev = numero(d && d.f60);
      if (faixaMinerio(p)) { const v = isFinite(numero(d.f170)) ? numero(d.f170) : prev > 0 ? (p / prev - 1) * 100 : NaN; if (isFinite(v)) { diag.minerio = 'eastmoney ' + cod; return { p, v, moeda: 'CNY', fonte: 'eastmoney' }; } }
    }
    erros.push('eastmoney: sem contrato válido');
  } catch (e) { erros.push('eastmoney: ' + e.message); }
  diag.minerio = 'dalian indisponível: ' + erros.join(' | ');
  return null;
}

/* ---------- mensagens ---------- */
const dolarTxt = (p) => 'US$ ' + num(p);
function linha(it, x) {
  if (it.barril) return '• ' + it.n + ': ' + pct(x.v) + ', a ' + dolarTxt(x.p) + ' o barril';
  if (it.btc) return '• ' + it.n + ': ' + pct(x.v) + ', a US$ ' + num(x.p);
  if (it.ex === 'usd') return '• ' + it.n + ': ' + dolarTxt(x.p) + ' (' + pct(x.v) + ')';
  if (it.ex === 'brl') return '• ' + it.n + ': R$ ' + num(x.p, 4) + ' (' + pct(x.v) + ')';
  if (it.ex === 'idx') return '• ' + it.n + ': ' + num(x.p) + ' (' + pct(x.v) + ')';
  return '• ' + it.n + ': ' + pct(x.v);
}
function msgManha(got, minerio, ibov) {
  const blocos = [];
  for (const g of GRUPOS) {
    const ls = g.itens.filter((i) => got[i.id]).map((i) => linha(i, got[i.id]));
    if (g.t.includes('Commodities')) {                 // minério de ferro depois do petróleo
      if (minerio) {
        const usd = got.usdcny && got.usdcny.p > 0 ? ' (US$ ' + num(minerio.p / got.usdcny.p) + ')' : '';
        ls.push('• Minério de ferro (bolsa de Dalian, China): ' + pct(minerio.v) + ', a ' + num(minerio.p, 0) + ' iuanes' + usd);
      } else if (got.tio) ls.push('• Minério de ferro (Cingapura): ' + pct(got.tio.v) + ', a ' + dolarTxt(got.tio.p) + ' a tonelada');
    }
    if (g.t.includes('Extras') && ibov) ls.push('• Ibovespa (última cotação): ' + num(ibov.p, 0) + ' pts (' + pct(ibov.v) + ')');
    if (ls.length) blocos.push(g.t + '\n' + ls.join('\n'));
  }
  const nota = 'Futuros do Ibovespa e do dólar (B3): a partir das 9h10, em outra mensagem.';
  return ['🔎 Veja os principais indicadores · ' + DIAS[DOW] + ', ' + dataBR(HOJE), ...blocos, nota, 'Dados coletados às ' + coletadoAs() + ' (horário de Brasília). Fontes: CNBC, Yahoo Finance, Stooq, Sina, Eastmoney, CoinGecko e B3; podem ter atraso.', 'Conteúdo educacional. Não é recomendação de investimento.'].join('\n\n');
}
function msgFuturos(br) {
  const l = [];
  if (br.win) l.push(sinal(br.win.v) + ' Ibovespa futuro (' + br.win.t + '): ' + num(br.win.p, 0) + ' pts (' + pct(br.win.v) + ')');
  if (br.wdo) l.push(sinal(br.wdo.v) + ' Dólar futuro (' + br.wdo.t + '): R$ ' + num(br.wdo.p / 1000, 3) + ' (' + pct(br.wdo.v) + ')');
  if (br.ibov) l.push('Ibovespa (última cotação): ' + num(br.ibov.p, 0) + ' pts (' + pct(br.ibov.v) + ')');
  if (!br.win && !br.wdo) return '';
  return ['🇧🇷 FUTUROS BRASILEIROS · ' + DIAS[DOW] + ', ' + dataBR(HOJE), l.join('\n'), 'Dados coletados às ' + coletadoAs() + ' (horário de Brasília). Fonte: B3, com atraso de cerca de 15 minutos.', 'Conteúdo educacional. Não é recomendação de investimento.'].join('\n\n');
}

const ASSINATURA = ASSINATURA_ELPIS();
async function enviar(corpo) {
  const texto = corpo + ASSINATURA;
  if (TESTE) { console.log('--- MENSAGEM (teste, não enviada) ---\n' + texto + '\n--- fim ---'); return; }
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('faltam os segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
  const r = await fetch(API + '/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram recusou: ' + (j.description || 'HTTP ' + r.status));
  console.log('enviado ao Telegram.');
}

/* ---------- execução (só quando rodado direto, não quando importado nos testes) ---------- */
if (process.argv[1] && process.argv[1].endsWith('abertura.mjs')) {
  const est = lerJson('abertura.json') || {};
  const salvar = (k) => { if (!TESTE) fs.writeFileSync(path.join(SAIDA, 'abertura.json'), JSON.stringify(Object.assign({}, est.data === HOJE ? est : {}, { data: HOJE, [k]: true }))); };
  if (DOW === 0 || DOW === 6) { console.log('fim de semana: sem resumo de abertura.'); process.exit(0); }
  if (est.data === HOJE && est[MODO] && !FORCAR) { console.log('esta parte (' + MODO + ') já foi enviada hoje.'); process.exit(0); }
  const diag = { gerado: new Date().toISOString(), modo: MODO }, hojeUtc = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
  const gravaDiag = () => { try { fs.writeFileSync(path.join(SAIDA, 'abertura-diag-' + MODO + '.json'), JSON.stringify(diag, null, 1)); } catch (e) { /* ignora */ } };
  try {
    if (MODO === 'futuros') {
      const br = {};
      for (const [k, tk] of [['win', contratoWin(hojeUtc)], ['wdo', contratoWdo(hojeUtc)], ['ibov', 'IBOV']]) {
        try { br[k] = await cotacaoB3(tk); } catch (e) { diag['b3_' + k] = 'erro: ' + e.message; }
      }
      diag.brasil = Object.keys(br); gravaDiag();
      const t = msgFuturos(br);
      if (!t) { console.warn('aviso: futuros da B3 indisponíveis; nada enviado.'); process.exit(0); }
      await enviar(t); salvar('futuros');
    } else {
      const got = {};
      await viaCoinGecko(got, diag);
      await viaCnbc(TODOS, got, diag);
      await viaYahoo(TODOS, got, diag);
      await viaStooq(TODOS, got, diag);
      const minerio = await minerioDalian(diag);
      let ibov = null; try { ibov = await cotacaoB3('IBOV'); } catch (e) { diag.b3_ibov = 'erro: ' + e.message; }
      diag.itens = Object.fromEntries(Object.entries(got).map(([k, x]) => [k, x.fonte]));
      diag.faltando = TODOS.filter((i) => !got[i.id]).map((i) => i.id); gravaDiag();
      console.log('abertura:', Object.keys(got).length + '/' + TODOS.length, 'itens | minério:', diag.minerio, '| faltando:', diag.faltando.join(',') || '-');
      if (Object.keys(got).length < 5) { console.warn('aviso: poucos dados disponíveis; nada enviado.'); process.exit(0); }
      await enviar(msgManha(got, minerio, ibov)); salvar('manha');
    }
  } catch (e) { console.error('ERRO:', e.message); process.exitCode = 1; }
}
