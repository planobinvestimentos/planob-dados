/* PROVENTOS DOS ÚLTIMOS 12 MESES de FIIs e ETFs (por cota), para a carteira do site calcular o preço-teto sozinha.
   Roda no GitHub Actions (proventos12m.yml), 1 vez por dia. Escreve saida/proventos12m.json e saida/proventos12m-diag.json. NÃO envia nada ao Telegram.
   Fonte principal: Yahoo Finance (CÓDIGO.SA). 2ª fonte, para o que o Yahoo não trouxer: site da B3 (fundos e empresas listadas), com data de pagamento real. Quem sobe: universo da B3 (saida/universo.json: FIIs e ETFs), liquidez (saida/liquidez-fiis.json) e ETFs em destaque.
   Se o Yahoo falhar para um código, ele é ignorado (o site avisa que não há dado e o usuário pode digitar). Se falhar para quase todos, mantém o arquivo anterior e termina em erro.
   Também grava saida/proventos-hist.json: histórico de ~6 anos de ações, FIIs e ETFs ([data ex, valor por cota]) para o site lançar sozinho os proventos de quem comprou no passado.
   Formato: { gerado, fonte, itens: { "ETHY11": [dpa12, quantidade_de_pagamentos, "AAAA-MM-DD" do último, valor_do_último] } }
   Opcionais: TESTE=1 (não grava), EXTRAS=COD1,COD2 (códigos a mais), YAHOO_URL, LIMITE=N (só os N primeiros, para teste), PAUSA_MS. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ETFS_DESTAQUE } from './lib.mjs';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = process.env.SAIDA_DIR || path.join(RAIZ, 'saida');
const TESTE = process.env.TESTE === '1';
const YAHOO = (process.env.YAHOO_URL || 'https://query1.finance.yahoo.com').replace(/\/+$/, '');
const PAUSA = Number(process.env.PAUSA_MS || 350);
const hoje = process.env.DATA_TESTE || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const lerJson = (n, pad) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, n), 'utf8')); } catch (e) { return pad; } };
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const menos1ano = (d) => (Number(d.slice(0, 4)) - 1) + d.slice(4);
const r6 = (x) => Math.round(x * 1e6) / 1e6;

/* quais códigos consultar */
const universo = lerJson('universo.json', { itens: {} }), liq = lerJson('liquidez-fiis.json', null);
const cods = new Set(ETFS_DESTAQUE), fiietf = new Set(ETFS_DESTAQUE);
for (const [tk, it] of Object.entries(universo.itens || {})) if ((it.cls === 'FII' || it.cls === 'ETF' || it.cls === 'Ação') && !it.sumiu) { cods.add(tk); if (it.cls !== 'Ação') fiietf.add(tk); }
if (liq && liq.fiis) Object.keys(liq.fiis).forEach((t) => { cods.add(t); fiietf.add(t); });
String(process.env.EXTRAS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).forEach((t) => { cods.add(t); fiietf.add(t); });
let lista = [...cods].filter((t) => /^[A-Z]{4}\d{1,2}$/.test(t)).sort();
if (process.env.LIMITE) lista = lista.slice(0, Number(process.env.LIMITE));

async function buscar(tk) {
  let ultimoErro;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${YAHOO}/v8/finance/chart/${tk}.SA?range=6y&interval=1d&events=div`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlanoB-Proventos/1.0)', Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
      if (r.status === 404) return { vazio: true };
      if (r.status === 429) { await dorme(3000 * (i + 1)); ultimoErro = new Error('HTTP 429'); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(), res = j.chart && j.chart.result && j.chart.result[0];
      if (!res) return { vazio: true };
      const ev = res.events && res.events.dividends ? Object.values(res.events.dividends) : [];
      return { ev: ev.map((e) => ({ d: iso(e.date), v: Number(e.amount) })).filter((e) => e.v > 0).sort((a, b) => (a.d < b.d ? -1 : 1)) };
    } catch (e) { ultimoErro = e; await dorme(1200 * (i + 1)); }
  }
  throw ultimoErro;
}

const itens = {}, hist = {}, semDado = [], erros = [], viaB3 = [];
const ini = menos1ano(hoje);
const somaDia = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dataISO = (br) => { const m = String(br || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; };
const numero = (x) => { x = String(x == null ? '' : x).trim(); if (!x) return NaN; return x.includes(',') ? parseFloat(x.replace(/\./g, '').replace(',', '.')) : parseFloat(x); };
/* registra os eventos de um código: ev = [{d: data ex, v: valor por cota, pag?: data de pagamento}] */
function registrar(tk, ev) {
  ev = ev.filter((e) => e.d <= hoje && e.v > 0).sort((a, b) => (a.d < b.d ? -1 : 1));
  if (!ev.length) return false;
  hist[tk] = ev.map((e) => (e.pag ? [e.d, r6(e.v), e.pag] : [e.d, r6(e.v)]));
  const u12 = ev.filter((e) => e.d > ini);
  if (fiietf.has(tk) && u12.length) { const u = u12[u12.length - 1]; itens[tk] = [r6(u12.reduce((s, e) => s + e.v, 0)), u12.length, u.d, r6(u.v)]; }
  return u12.length > 0;
}
let k = 0;
async function trabalho() {
  while (k < lista.length) {
    const tk = lista[k++];
    try {
      const b = await buscar(tk);
      if (!registrar(tk, b.ev || [])) semDado.push(tk);
    } catch (e) { erros.push(tk + ': ' + e.message); }
    await dorme(PAUSA);
  }
}
await Promise.all([trabalho(), trabalho(), trabalho()]);

/* ---- 2ª fonte: site da B3 (a mesma usada nos avisos de proventos). Só para quem o Yahoo não trouxe nos últimos 12 meses.
   Traz também a data de pagamento real. Fundos/ETFs: GetListedSupplementFunds; ações: GetListedSupplementCompany. ---- */
const B3_FUNDOS = process.env.B3_FUNDOS_URL || 'https://sistemaswebb3-listados.b3.com.br/fundsProxy/fundsCall/GetListedSupplementFunds/';
const B3_EMP = process.env.B3_EMP_URL || 'https://sistemaswebb3-listados.b3.com.br/listedCompaniesProxy/CompanyCall/GetListedSupplementCompany/';
const isinPara = {};
for (const [tk, it] of Object.entries(universo.itens || {})) if (it.isin) isinPara[it.isin] = tk;
async function pegarB3(url) {
  let ultimo;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlanoB-Proventos/1.0)', Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { ultimo = e; await dorme(1500 * (i + 1)); }
  }
  throw ultimo;
}
const faltam = [...new Set([...semDado, ...erros.map((x) => x.split(':')[0])])];
const raizes = {};
for (const tk of faltam) (raizes[tk.slice(0, 4)] = raizes[tk.slice(0, 4)] || []).push(tk);
const b3 = { consultadas: Object.keys(raizes).length, ok: 0, falhas: 0, recuperados: 0, erro: null, amostra: null };
const filaB3 = Object.keys(raizes);
async function trabalhoB3() {
  while (filaB3.length && !b3.erro) {
    const cod = filaB3.shift(), tks = raizes[cod];
    const eFundo = tks.some((t) => fiietf.has(t));
    const url = eFundo ? B3_FUNDOS + Buffer.from(JSON.stringify({ identifierFund: cod, typeFund: 7, cnpj: '' })).toString('base64') : B3_EMP + Buffer.from(JSON.stringify({ language: 'pt-br', issuingCompany: cod })).toString('base64');
    try {
      const j = await pegarB3(url); b3.ok++;
      const caixa = (Array.isArray(j) ? j : [j]).flatMap((x) => (x && x.cashDividends) || []);
      if (!b3.amostra && caixa.length) b3.amostra = { codigo: cod, campos: Object.keys(caixa[0]), primeiro: caixa[0] };
      const isins = new Set(caixa.map((c) => c.assetIssued || c.isinCode).filter(Boolean));
      const porTk = {};
      for (const c of caixa) {
        if (/AMORTIZ|RESTITU/i.test(c.label || '')) continue;   /* amortização e devolução de capital não são renda */
        const isin = c.assetIssued || c.isinCode;
        let tk = isinPara[isin];
        if (!tk && isins.size === 1 && tks.length === 1) tk = tks[0];   /* sem ISIN no cadastro: só vale se há um único papel possível */
        const v = numero(c.rate), com = dataISO(c.lastDatePrior);
        if (!tk || !tks.includes(tk) || !(v > 0) || !com) continue;
        (porTk[tk] = porTk[tk] || []).push({ d: somaDia(com, 1), v, pag: dataISO(c.paymentDate) || undefined });
      }
      for (const [tk, ev] of Object.entries(porTk)) {
        const vistos = new Set(), unicos = ev.filter((e) => { const ch = e.d + '|' + e.v; if (vistos.has(ch)) return false; vistos.add(ch); return true; });
        if (registrar(tk, unicos)) { b3.recuperados++; viaB3.push(tk); const q = semDado.indexOf(tk); if (q >= 0) semDado.splice(q, 1); }
      }
    } catch (e) {
      b3.falhas++;
      if (b3.falhas >= 8 && b3.ok === 0) b3.erro = 'as primeiras consultas à B3 falharam (' + e.message + '): endereço bloqueado ou mudou';
    }
    await dorme(120);
  }
}
if (!process.env.SEM_B3) await Promise.all([trabalhoB3(), trabalhoB3(), trabalhoB3()]);
console.log('B3 (2ª fonte):', JSON.stringify({ consultadas: b3.consultadas, ok: b3.ok, falhas: b3.falhas, recuperados: b3.recuperados, erro: b3.erro }));

const diag = { gerado: new Date().toISOString(), consultados: lista.length, com_dados: Object.keys(itens).length, sem_dados: semDado.length, erros: erros.length, exemplos_erro: erros.slice(0, 8), exemplos_sem_dados: semDado.slice(0, 30), via_b3: viaB3.length, b3, etfs_destaque: Object.fromEntries(ETFS_DESTAQUE.map((t) => [t, itens[t] ? { ...{ dpa12: itens[t][0], pagamentos: itens[t][1], ultimo: itens[t][2] }, fonte: viaB3.includes(t) ? 'B3' : 'Yahoo' } : null])) };
console.log(JSON.stringify(diag, null, 1));
const okMin = Math.max(5, Math.floor(lista.filter((t) => fiietf.has(t)).length * 0.2));
if (!TESTE) {
  fs.mkdirSync(SAIDA, { recursive: true });
  fs.writeFileSync(path.join(SAIDA, 'proventos12m-diag.json'), JSON.stringify(diag, null, 1));
  if (Object.keys(itens).length >= okMin) {
    fs.writeFileSync(path.join(SAIDA, 'proventos12m.json'), JSON.stringify({ gerado: hoje, fonte: 'Yahoo Finance e B3 (dividendos dos últimos 12 meses)', itens }));
    fs.writeFileSync(path.join(SAIDA, 'proventos-hist.json'), JSON.stringify({ gerado: hoje, fonte: 'Yahoo Finance e B3 (histórico de proventos: data ex, valor bruto por cota, data de pagamento quando conhecida)', itens: hist }));
  }
  else { console.error('ERRO: poucos códigos com dados (' + Object.keys(itens).length + ' de ' + lista.length + '); o arquivo anterior foi mantido.'); process.exitCode = 1; }
}
