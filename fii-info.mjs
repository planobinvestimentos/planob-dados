/* Segmento e VALOR PATRIMONIAL por cota dos FIIs, a partir do Informe Mensal dos FIIs (dados abertos da CVM). Serve para mostrar, nos avisos de proventos,
   o tipo do fundo (Tijolo/Papel/segmento) e o P/VP (preço da cota dividido pelo valor patrimonial por cota).
   Roda no GitHub Actions junto com o workflow "Liquidez dos FIIs" (toda segunda e à mão):  node fii-info.mjs
   Fonte (sem chave e sem custo): https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS/inf_mensal_fii_AAAA.zip  (arquivos "geral" e "complemento").
   O informe sai por volta do dia 10 do mês seguinte, então o valor patrimonial tem de 1 a 2 meses de defasagem (a mensagem avisa).
   Liga o ticker ao fundo pelo código ISIN (cadastro saida/universo.json). Fundo sem ISIN ou sem informe fica sem P/VP e o aviso sai normalmente.
   Resultado: saida/fii-info.json  { gerado, itens: { HGLG11: { vp, ref, seg, cotistas } } }  e saida/fii-info-diag.json (o que foi encontrado, para conferir).
   Se a CVM falhar, o arquivo anterior é mantido. Opcionais: CVM_FII_URL, SAIDA_DIR, ANO_TESTE. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerZip, lerCsv } from './lib.mjs';

const SAIDA = process.env.SAIDA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const BASE = process.env.CVM_FII_URL || 'https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS/';
const UA = { 'User-Agent': 'PlanoB-Investimentos-dados/1.0 (uso educacional)' };
const ANO = Number(process.env.ANO_TESTE) || new Date().getUTCFullYear();
const diag = { gerado: new Date().toISOString(), anos: {} };
const lerJson = (arq, padrao = null) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, arq), 'utf8')); } catch (e) { return padrao; } };
const gravarDiag = () => fs.writeFileSync(path.join(SAIDA, 'fii-info-diag.json'), JSON.stringify(diag, null, 1));
const campo = (o, re) => { const k = Object.keys(o).find((x) => re.test(x)); return k ? o[k] : ''; };
const numero = (s) => { s = String(s || '').trim(); const v = parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); return Number.isFinite(v) ? v : NaN; };
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const refMes = (d) => String(d || '').slice(0, 7);    // AAAA-MM-DD → AAAA-MM

async function baixarAno(ano) {
  const r = await fetch(BASE + 'inf_mensal_fii_' + ano + '.zip', { headers: UA, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' em inf_mensal_fii_' + ano + '.zip');
  const zip = lerZip(Buffer.from(await r.arrayBuffer()));
  const nome = (re) => [...zip.keys()].find((k) => re.test(k.toLowerCase()));
  const g = nome(/geral.*\.csv$/), c = nome(/complemento.*\.csv$/);
  if (!g || !c) throw new Error('arquivos geral/complemento não encontrados no zip de ' + ano + ': ' + [...zip.keys()].join(', '));
  return { geral: lerCsv(zip.get(g)), compl: lerCsv(zip.get(c)) };
}

/* informe mais recente de cada fundo (maior data de referência; na mesma data, a maior versão) */
function maisRecentes(linhas, extrai) {
  const m = new Map();
  for (const l of linhas) {
    const cnpj = soDigitos(campo(l, /^CNPJ/)), ref = campo(l, /^DATA_REFERENCIA/), ver = Number(campo(l, /^VERSAO/)) || 0;
    if (!cnpj || !ref) continue;
    const a = m.get(cnpj);
    if (!a || ref > a.ref || (ref === a.ref && ver > a.ver)) m.set(cnpj, { ref, ver, ...extrai(l) });
  }
  return m;
}

try {
  const universo = (lerJson('universo.json', { itens: {} }) || {}).itens || {};
  const isinParaTicker = {};
  for (const [tk, it] of Object.entries(universo)) if (it.isin && /11$/.test(tk)) isinParaTicker[it.isin] = tk;
  diag.isins_no_cadastro = Object.keys(isinParaTicker).length;
  if (diag.isins_no_cadastro < 50) throw new Error('cadastro de códigos (universo.json) sem ISIN suficiente; rode o workflow "Atualizar dados" antes');

  /* ano atual e anterior (o anterior cobre fundos sem informe novo ainda em janeiro) */
  const geral = new Map(), compl = new Map();
  for (const ano of [ANO - 1, ANO]) {
    try {
      const { geral: g, compl: c } = await baixarAno(ano);
      diag.anos[ano] = { linhas_geral: g.length, linhas_complemento: c.length, colunas_geral: Object.keys(g[0] || {}).slice(0, 40), colunas_complemento: Object.keys(c[0] || {}).slice(0, 40) };
      for (const [k, v] of maisRecentes(g, (l) => ({ isin: campo(l, /ISIN/), seg: campo(l, /^SEGMENTO/), nome: campo(l, /^NOME/) }))) { const a = geral.get(k); if (!a || v.ref >= a.ref) geral.set(k, Object.assign({}, a || {}, v, { isin: v.isin || (a && a.isin) || '' })); }
      for (const [k, v] of maisRecentes(c, (l) => ({ vp: numero(campo(l, /^VALOR_PATRIMONIAL_COTAS/)), pl: numero(campo(l, /^PATRIMONIO_LIQUIDO/)), cotas: numero(campo(l, /^(TOTAL_NUMERO_COTAS|COTAS_EMITIDAS|NUMERO_COTAS)/)), cotistas: numero(campo(l, /^TOTAL_NUMERO_COTISTAS/)) }))) { const a = compl.get(k); if (!a || v.ref >= a.ref) compl.set(k, v); }
    } catch (e) { diag.anos[ano] = { erro: e.message }; console.warn('aviso:', e.message); }
  }
  if (!geral.size || !compl.size) throw new Error('a CVM não entregou os informes (geral ' + geral.size + ', complemento ' + compl.size + ')');

  const itens = {};
  const liq = Object.keys((lerJson('liquidez-fiis.json', {}) || {}).fiis || {});
  let semIsin = 0, semVp = 0;
  for (const [cnpj, g] of geral) {
    const tk = isinParaTicker[g.isin];
    if (!tk) { semIsin++; continue; }
    const c = compl.get(cnpj);
    let vp = c ? c.vp : NaN;
    if (!(vp > 0) && c && c.pl > 0 && c.cotas > 0) vp = c.pl / c.cotas;
    const item = {};
    if (g.seg) item.seg = g.seg;
    if (vp > 0 && vp < 100000) { item.vp = Math.round(vp * 10000) / 10000; item.ref = refMes(c.ref); } else semVp++;
    if (c && c.cotistas > 0) item.cotistas = Math.round(c.cotistas);                 // número de cotistas
    if (item.seg || item.vp) itens[tk] = item;
  }
  Object.assign(diag, { fundos_no_informe: geral.size, tickers_ligados: Object.keys(itens).length, sem_isin_no_cadastro: semIsin, sem_valor_patrimonial: semVp, exemplo: Object.entries(itens).slice(0, 5) });
  /* conferência: dos FIIs líquidos, quantos ficaram com P/VP */
  if (liq.length) { diag.liquidos = liq.length; diag.liquidos_com_vp = liq.filter((t) => itens[t] && itens[t].vp).length; diag.liquidos_sem_vp = liq.filter((t) => !(itens[t] && itens[t].vp)).slice(0, 40); }
  if (Object.keys(itens).length < 50) throw new Error('poucos fundos ligados (' + Object.keys(itens).length + '); arquivo anterior mantido');
  fs.writeFileSync(path.join(SAIDA, 'fii-info.json'), JSON.stringify({ gerado: diag.gerado.slice(0, 10), itens }));
  diag.resultado = 'ok';
  gravarDiag();
  console.log('fii-info ok:', Object.keys(itens).length, 'FIIs com segmento/valor patrimonial' + (diag.liquidos ? ' (' + diag.liquidos_com_vp + ' de ' + diag.liquidos + ' líquidos com P/VP)' : ''));
} catch (e) {
  diag.resultado = 'ERRO: ' + e.message;
  try { gravarDiag(); } catch (x) { /* ignora */ }
  console.error('ERRO:', e.message);
  process.exitCode = 1;
}
