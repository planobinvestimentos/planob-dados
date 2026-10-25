/* PROVENTOS DOS ÚLTIMOS 12 MESES de FIIs e ETFs (por cota), para a carteira do site calcular o preço-teto sozinha.
   Roda no GitHub Actions (proventos12m.yml), 1 vez por dia. Escreve saida/proventos12m.json e saida/proventos12m-diag.json. NÃO envia nada ao Telegram.
   Fonte: Yahoo Finance (eventos de dividendos de CÓDIGO.SA). Quem sobe: universo da B3 (saida/universo.json: FIIs e ETFs), liquidez (saida/liquidez-fiis.json) e ETFs em destaque.
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

const itens = {}, hist = {}, semDado = [], erros = [];
const ini = menos1ano(hoje);
let k = 0;
async function trabalho() {
  while (k < lista.length) {
    const tk = lista[k++];
    try {
      const b = await buscar(tk);
      if (b.ev && b.ev.length) hist[tk] = b.ev.filter((e) => e.d <= hoje).map((e) => [e.d, r6(e.v)]);
      const ev = (b.ev || []).filter((e) => e.d > ini && e.d <= hoje);
      if (!ev.length) { semDado.push(tk); }
      else if (fiietf.has(tk)) { const u = ev[ev.length - 1]; itens[tk] = [r6(ev.reduce((s, e) => s + e.v, 0)), ev.length, u.d, r6(u.v)]; }
    } catch (e) { erros.push(tk + ': ' + e.message); }
    await dorme(PAUSA);
  }
}
await Promise.all([trabalho(), trabalho(), trabalho()]);

const diag = { gerado: new Date().toISOString(), consultados: lista.length, com_dados: Object.keys(itens).length, sem_dados: semDado.length, erros: erros.length, exemplos_erro: erros.slice(0, 8), exemplos_sem_dados: semDado.slice(0, 30), etfs_destaque: Object.fromEntries(ETFS_DESTAQUE.map((t) => [t, itens[t] || null])) };
console.log(JSON.stringify(diag, null, 1));
const okMin = Math.max(5, Math.floor(lista.filter((t) => fiietf.has(t)).length * 0.2));
if (!TESTE) {
  fs.mkdirSync(SAIDA, { recursive: true });
  fs.writeFileSync(path.join(SAIDA, 'proventos12m-diag.json'), JSON.stringify(diag, null, 1));
  if (Object.keys(itens).length >= okMin) {
    fs.writeFileSync(path.join(SAIDA, 'proventos12m.json'), JSON.stringify({ gerado: hoje, fonte: 'Yahoo Finance (dividendos dos últimos 12 meses)', itens }));
    fs.writeFileSync(path.join(SAIDA, 'proventos-hist.json'), JSON.stringify({ gerado: hoje, fonte: 'Yahoo Finance (histórico de proventos, data ex, valor bruto por cota)', itens: hist }));
  }
  else { console.error('ERRO: poucos códigos com dados (' + Object.keys(itens).length + ' de ' + lista.length + '); o arquivo anterior foi mantido.'); process.exitCode = 1; }
}
