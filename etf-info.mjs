/* Valor patrimonial por cota (VP) dos ETFs, a partir do Informe Diário dos fundos da CVM (dados abertos, sem chave e sem custo).
   Serve para o site calcular o P/VP do ETF (preço ÷ valor patrimonial por cota), igual ao dos FIIs.
   Roda no GitHub Actions (workflow "ETFs: valor patrimonial por cota", todo dia útil e à mão):  node etf-info.mjs
   Liga cada ticker ao CNPJ do fundo pelo arquivo etfs-cnpj.json (ticker → CNPJ, editado pelo GitHub). Sem CNPJ preenchido, o ETF fica sem P/VP.
   Fonte: https://dados.cvm.gov.br/dados/FI/DOC/INF_DIARIO/DADOS/inf_diario_fi_AAAAMM.zip  (campos CNPJ_FUNDO, DT_COMPTC, VL_QUOTA, VL_PATRIM_LIQ).
   Pega a cota mais recente de cada CNPJ nos dois últimos meses. O informe diário sai com um dia útil de defasagem (a data aparece no site).
   Resultado: saida/etf-info.json  { gerado, itens: { COIN11: { vp, ref, nome, pl } } }  e saida/etf-info-diag.json (o que foi encontrado, para conferir).
   Se a CVM falhar ou nenhum ETF aparecer, o arquivo anterior é mantido. Opcionais: CVM_DIARIO_URL, SAIDA_DIR. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerZip } from './lib.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = process.env.SAIDA_DIR || path.join(DIR, 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const BASE = process.env.CVM_DIARIO_URL || 'https://dados.cvm.gov.br/dados/FI/DOC/INF_DIARIO/DADOS/';
const UA = { 'User-Agent': 'PlanoB-Investimentos-dados/1.0 (uso educacional)' };
const diag = { gerado: new Date().toISOString(), meses: {} };
const gravarDiag = () => { try { fs.writeFileSync(path.join(SAIDA, 'etf-info-diag.json'), JSON.stringify(diag, null, 1)); } catch (e) { /* ignora */ } };
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const numero = (s) => { s = String(s || '').trim(); const v = parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); return Number.isFinite(v) ? v : NaN; };

/* AAAAMM de agora e do mês anterior */
function mesesRecentes(n) {
  const h = new Date(), out = [];
  for (let i = 0; i < n; i++) { const d = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() - i, 1)); out.push(d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0')); }
  return out;
}

async function baixarMes(aaaamm) {
  const r = await fetch(BASE + 'inf_diario_fi_' + aaaamm + '.zip', { headers: UA, signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' em inf_diario_fi_' + aaaamm + '.zip');
  const zip = lerZip(Buffer.from(await r.arrayBuffer()));
  const nome = [...zip.keys()].find((k) => /\.csv$/i.test(k));
  if (!nome) throw new Error('CSV não encontrado no zip de ' + aaaamm + ': ' + [...zip.keys()].join(', '));
  return zip.get(nome).toString('latin1');
}

/* cota mais recente de cada CNPJ da lista (só guarda as linhas desses fundos, para poupar memória) */
function ultimasCotas(texto, cnpjs) {
  const linhas = texto.split(/\r?\n/);
  const cab = (linhas.shift() || '').split(';').map((c) => c.trim().replace(/[^A-Za-z_]/g, '').toUpperCase());
  const col = (nome) => cab.findIndex((c) => c === nome || c.endsWith(nome));
  const iC = col('CNPJ_FUNDO'), iD = col('DT_COMPTC'), iQ = col('VL_QUOTA'), iP = col('VL_PATRIM_LIQ');
  if (iC < 0 || iD < 0 || iQ < 0) throw new Error('colunas do informe diário diferentes do esperado: ' + cab.join(';'));
  const melhor = new Map();
  for (const l of linhas) {
    if (!l) continue;
    const c = l.split(';');
    const cnpj = soDigitos(c[iC]);
    if (!cnpjs.has(cnpj)) continue;
    const data = (c[iD] || '').trim(), vp = numero(c[iQ]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !(vp > 0)) continue;
    const a = melhor.get(cnpj);
    if (!a || data > a.ref) melhor.set(cnpj, { ref: data, vp, pl: iP >= 0 ? numero(c[iP]) : NaN });
  }
  return melhor;
}

try {
  const mapa = JSON.parse(fs.readFileSync(path.join(DIR, 'etfs-cnpj.json'), 'utf8')).itens || {};
  const cnpjParaTk = new Map();
  const semCnpj = [];
  for (const [tk, it] of Object.entries(mapa)) {
    const d = soDigitos(it && it.cnpj);
    if (d.length === 14) cnpjParaTk.set(d, tk); else semCnpj.push(tk);
  }
  Object.assign(diag, { cnpj_preenchidos: cnpjParaTk.size, sem_cnpj: semCnpj });
  if (!cnpjParaTk.size) throw new Error('etfs-cnpj.json sem nenhum CNPJ preenchido');

  const melhor = new Map();
  for (const mes of mesesRecentes(2)) {
    try {
      const achados = ultimasCotas(await baixarMes(mes), new Set(cnpjParaTk.keys()));
      diag.meses[mes] = { fundos_achados: achados.size };
      for (const [cnpj, v] of achados) { const a = melhor.get(cnpj); if (!a || v.ref > a.ref) melhor.set(cnpj, v); }
    } catch (e) { diag.meses[mes] = { erro: e.message }; console.warn('aviso:', e.message); }
  }
  if (!melhor.size) throw new Error('nenhum ETF do cadastro apareceu no informe diário da CVM');

  const itens = {}, semDados = [];
  for (const [cnpj, tk] of cnpjParaTk) {
    const v = melhor.get(cnpj);
    if (!v) { semDados.push(tk); continue; }
    const item = { vp: Math.round(v.vp * 10000) / 10000, ref: v.ref, nome: (mapa[tk] && mapa[tk].nome) || '' };
    if (v.pl > 0) item.pl = Math.round(v.pl);
    itens[tk] = item;
  }
  Object.assign(diag, { tickers_ligados: Object.keys(itens).length, sem_dados_na_cvm: semDados, exemplo: Object.entries(itens).slice(0, 5) });
  if (!Object.keys(itens).length) throw new Error('nenhum ETF com cota válida; arquivo anterior mantido');
  fs.writeFileSync(path.join(SAIDA, 'etf-info.json'), JSON.stringify({ gerado: diag.gerado.slice(0, 10), itens }));
  diag.resultado = 'ok';
  gravarDiag();
  console.log('etf-info ok:', Object.keys(itens).length, 'ETFs com valor patrimonial por cota');
} catch (e) {
  diag.resultado = 'ERRO: ' + e.message;
  gravarDiag();
  console.error('ERRO:', e.message);
  process.exitCode = 1;
}
