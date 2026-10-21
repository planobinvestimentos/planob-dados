/* Cotações globais para o PAINEL DO MERCADO (futuros-imagem.mjs): commodities, dólar no mundo (DXY e 23 moedas) e minério de Dalian.
   Mesma estratégia da abertura das 6h (abertura.mjs): cada item tem um código em cada fonte e as fontes são tentadas em ordem, sem chave e sem custo:
     1) CNBC (uma consulta traz todos os itens),  2) Yahoo Finance (um por vez),  3) Stooq (um por vez).
   Minério de ferro: Sina e Eastmoney (bolsa de Dalian, em iuanes). Milho e boi gordo: cotação da B3 (contratos futuros, API pública da B3).
   Cada função devolve só o que conseguiu; o chamador decide se o que veio basta. Nada aqui envia mensagem. */
const B3 = process.env.B3_COTACAO_URL || 'https://cotacao.b3.com.br/mds/api/v1/instrumentQuotation/';
const CNBC = process.env.CNBC_URL || 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
const YAHOO = (process.env.YAHOO_URL || 'https://query1.finance.yahoo.com,https://query2.finance.yahoo.com').split(',');
const STOOQ = process.env.STOOQ_URL || 'https://stooq.com/q/d/l/';
const SINA = process.env.SINA_URL || 'https://hq.sinajs.cn/list=';
const EASTMONEY = process.env.EASTMONEY_URL || 'https://push2.eastmoney.com/api/qt/stock/get';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; PlanoB-Investimentos-aviso/1.0; uso educacional)', Accept: 'application/json, text/csv, */*' };

export const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
export const numero = (s) => { const v = parseFloat(String(s == null ? '' : s).replace(/[%,\s]/g, '')); return Number.isFinite(v) ? v : NaN; };
export async function pegar(url, { json = true, ms = 15000, tentativas = 2, headers = {} } = {}) {
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

/* ---------- itens: código em cada fonte (c = CNBC, y = Yahoo, s = Stooq) ---------- */
export const I = (id, n, o) => Object.assign({ id, n }, o);

/* grupos de commodities, como aparecem na imagem. fator: converte a unidade da fonte para a unidade mostrada */
export const COMMODITIES = [
  { nome: 'Energia', cor: '#F0463C', itens: [
    I('wti', 'Petróleo WTI', { c: '@CL.1', y: 'CL=F', s: 'cl.f', un: 'US$/barril' }),
    I('brent', 'Petróleo Brent', { c: '@LCO.1', y: 'BZ=F', s: 'cb.f', un: 'US$/barril' }),
    I('gas', 'Gás natural', { c: '@NG.1', y: 'NG=F', s: 'ng.f', un: 'US$/MMBtu' })] },
  { nome: 'Metais preciosos', cor: '#E3B341', itens: [
    I('ouro', 'Ouro', { c: '@GC.1', y: 'GC=F', s: 'gc.f', un: 'US$/onça troy' }),
    I('prata', 'Prata', { c: '@SI.1', y: 'SI=F', s: 'si.f', un: 'US$/onça troy' })] },
  { nome: 'Metais industriais', cor: '#19A0DB', itens: [
    I('minerio', 'Minério de ferro', { un: 'CNY/t (Dalian)', dec: 0, propria: 'dalian' }),
    I('cobre', 'Cobre', { c: '@HG.1', y: 'HG=F', s: 'hg.f', un: 'US$/t', fator: 2204.62 })] },          // a bolsa cota em US$ por libra-peso; x 2.204,62 = US$ por tonelada
  { nome: 'Agro (B3)', cor: '#6EE7A8', itens: [
    I('milho', 'Milho', { un: 'R$/saca', propria: 'b3', prefixo: 'CCM', meses: [1, 3, 5, 7, 9, 11] }),
    I('boi', 'Boi gordo', { un: 'R$/arroba', propria: 'b3', prefixo: 'BGI', meses: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }),
    I('soja', 'Soja', { c: '@S.1', y: 'ZS=F', s: 'zs.f', un: 'US$/saca', fator: 2.20462 / 100 })] },   // Chicago cota em US¢ por bushel; x 2,20462 / 100 = US$ por saca de 60 kg
  { nome: 'Agro (EUA)', cor: '#B7BCE0', itens: [
    I('trigo', 'Trigo', { c: '@W.1', y: 'ZW=F', s: 'zw.f', un: 'US¢/bushel' })] },
];

/* dólar contra 23 moedas emergentes (cotação: unidades da moeda por US$) */
export const MOEDAS = [
  ['RUB', 'Rublo'], ['TWD', 'Dólar Taiwanês'], ['PLN', 'Zloty'], ['CNY', 'Yuan'], ['MYR', 'Ringgit'], ['HKD', 'Dólar Hong Kong'], ['CZK', 'Coroa Tcheca'], ['KRW', 'Won'],
  ['SGD', 'Dólar Singapura'], ['ARS', 'Peso Argentino'], ['BRL', 'Real'], ['TRY', 'Lira Turca'], ['INR', 'Rupia Indiana'], ['ZAR', 'Rand'], ['THB', 'Baht'], ['PEN', 'Sol Peruano'],
  ['CLP', 'Peso Chileno'], ['RON', 'Leu Romeno'], ['IDR', 'Rupia Indonésia'], ['PHP', 'Peso Filipino'], ['HUF', 'Florim'], ['COP', 'Peso Colombiano'], ['MXN', 'Peso Mexicano'],
].map(([cod, nome]) => I('fx' + cod, nome, { cod, c: cod + '=', y: cod + '=X', s: 'usd' + cod.toLowerCase() }));
export const DXY = I('dxy', 'DXY', { c: '.DXY', y: 'DX-Y.NYB', s: 'dx.f' });

/* ---------- as três fontes ---------- */
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
      const p = numero(r.last), prev = numero(r.previous_day_closing);
      let v = numero(r.change_pct);
      if (!isFinite(v) && p > 0 && prev > 0) v = (p / prev - 1) * 100;
      if (p > 0 && isFinite(v)) got[it.id] = { p, v, fonte: 'cnbc' };
    }
    diag.cnbc = 'ok: ' + q.length + ' itens';
  } catch (e) { diag.cnbc = 'erro: ' + e.message; }
}
async function viaYahoo(itens, got, diag) {
  let ok = 0, erro = '', seguidas = 0, parou = false;
  for (const it of itens) {
    if (got[it.id] || !it.y) continue;
    if (seguidas >= 6) { parou = true; break; }                // 6 itens seguidos sem resposta: provável bloqueio, não insiste
    let achou = false;
    for (const h of YAHOO) {
      try {
        const j = await pegar(h + '/v8/finance/chart/' + encodeURIComponent(it.y) + '?range=1d&interval=1d&includePrePost=true', { tentativas: 1, ms: 10000 });
        const m = j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
        const p = m && m.regularMarketPrice, prev = m && (m.chartPreviousClose || m.previousClose);
        if (p > 0 && prev > 0) { got[it.id] = { p, v: (p / prev - 1) * 100, fonte: 'yahoo' }; ok++; achou = true; break; }
      } catch (e) { erro = e.message; }
    }
    seguidas = achou ? 0 : seguidas + 1;
    await dorme(150);
  }
  diag.yahoo = ok + ' ok' + (parou ? ' (parou: várias falhas seguidas)' : '') + (erro ? ' (último erro: ' + erro + ')' : '');
}
async function viaStooq(itens, got, diag) {
  let ok = 0, erro = '', seguidas = 0, parou = false;
  for (const it of itens) {
    if (got[it.id] || !it.s) continue;
    if (seguidas >= 6) { parou = true; break; }
    let achou = false;
    try {
      const csv = await pegar(STOOQ + '?s=' + encodeURIComponent(it.s) + '&i=d', { json: false, tentativas: 1, ms: 12000 });
      const l = csv.trim().split(/\r?\n/).filter((x) => /^\d{4}-\d{2}-\d{2}/.test(x)).slice(-2).map((x) => x.split(','));
      if (l.length === 2) { const p = numero(l[1][4]), prev = numero(l[0][4]); if (p > 0 && prev > 0) { got[it.id] = { p, v: (p / prev - 1) * 100, fonte: 'stooq' }; ok++; achou = true; } }
    } catch (e) { erro = e.message; }
    seguidas = achou ? 0 : seguidas + 1;
    await dorme(150);
  }
  diag.stooq = ok + ' ok' + (parou ? ' (parou: várias falhas seguidas)' : '') + (erro ? ' (último erro: ' + erro + ')' : '');
}
/* CNBC -> Yahoo -> Stooq para os itens dados; devolve { id: { p, v, fonte } } e anota em diag */
export async function cotar(itens, diag = {}) {
  const got = {};
  await viaCnbc(itens, got, diag);
  await viaYahoo(itens, got, diag);
  await viaStooq(itens, got, diag);
  return got;
}

/* ---------- minério de ferro: bolsa de Dalian (China), em iuanes por tonelada ---------- */
const faixaMinerio = (p) => p > 300 && p < 3000;
export async function minerioDalian(diag = {}, hoje = new Date()) {
  const erros = [];
  try {
    const txt = await pegar(SINA + 'nf_I0', { json: false, tentativas: 2, headers: { Referer: 'https://finance.sina.com.cn' } });
    const m = txt.match(/="([^"]*)"/);
    const f = m ? m[1].split(',') : [];
    const p = numero(f[8]), prev = numero(f[10]);
    if (faixaMinerio(p) && prev > 0) { diag.minerio = 'sina'; return { p, v: (p / prev - 1) * 100, fonte: 'sina' }; }
    erros.push('sina: resposta fora do padrão');
  } catch (e) { erros.push('sina: ' + e.message); }
  try {
    const ano = hoje.getUTCFullYear(), mes = hoje.getUTCMonth() + 1, cand = [];
    for (let a = ano; a <= ano + 1 && cand.length < 3; a++) for (const m of [1, 5, 9]) if (a > ano || m >= mes) cand.push('i' + String(a).slice(2) + String(m).padStart(2, '0'));
    for (const cod of cand) {
      const j = await pegar(EASTMONEY + '?secid=114.' + cod + '&fields=f43,f60,f170&fltt=2&invt=2', { tentativas: 1 });
      const d = j && j.data, p = numero(d && d.f43), prev = numero(d && d.f60);
      if (faixaMinerio(p)) { const v = isFinite(numero(d.f170)) ? numero(d.f170) : prev > 0 ? (p / prev - 1) * 100 : NaN; if (isFinite(v)) { diag.minerio = 'eastmoney ' + cod; return { p, v, fonte: 'eastmoney' }; } }
    }
    erros.push('eastmoney: sem contrato válido');
  } catch (e) { erros.push('eastmoney: ' + e.message); }
  diag.minerio = 'dalian indisponível: ' + erros.join(' | ');
  return null;
}

/* ---------- B3: milho (CCM) e boi gordo (BGI), contratos futuros: o mais próximo que tiver cotação ---------- */
const LETRA = 'FGHJKMNQUVXZ';
export async function futuroB3(prefixo, meses, diag = {}, hoje = new Date()) {
  const cand = [];
  let a = hoje.getUTCFullYear(), m = hoje.getUTCMonth() + 1;
  for (let k = 0; k < 16 && cand.length < 4; k++) {
    if (meses.includes(m)) cand.push(prefixo + LETRA[m - 1] + String(a).slice(2));
    if (++m > 12) { m = 1; a++; }
  }
  const erros = [];
  for (const tk of cand) {
    try {
      const j = await pegar(B3 + tk, { tentativas: 1 });
      const q = j && j.Trad && j.Trad[0] && j.Trad[0].scty && j.Trad[0].scty.SctyQtn;
      if (q && q.curPrc > 0 && isFinite(Number(q.prcFlcn))) { diag[prefixo] = tk; return { p: q.curPrc, v: Number(q.prcFlcn), fonte: 'b3 ' + tk }; }
      erros.push(tk + ': sem cotação');
    } catch (e) { erros.push(tk + ': ' + e.message); }
  }
  diag[prefixo] = 'indisponível: ' + erros.join(' | ');
  return null;
}
