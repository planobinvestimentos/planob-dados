/* Gera dois arquivos pequenos que o site lê direto, sem servidor:
     saida/d1.json           fechamento do dia anterior (B3, dados de D-1 liberados sem custo)
     saida/fundamentos.json  LPA e VPA do último balanço anual (CVM, dados abertos)
     saida/bolsa.json        5 maiores altas e quedas de ações, FIIs de tijolo, FIIs de papel e ETFs (B3, último pregão)
     saida/universo.json     cadastro de códigos vistos na B3 (para achar novos, retirados e mudanças de código)
     saida/eventos.json      novos, retirados e mudanças de código do último pregão
     saida/proventos.json    proventos de FIIs e ações anunciados nos últimos dias (experimental)
   Uso:  node dados/gerar-dados.mjs [d1|fund|bolsa|bolsa-hoje|proventos|bcb|tudo]      (Node 18 ou mais novo) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerZip, lerCotahist, lerCotahistBolsa, ETFS_DESTAQUE, urlCotahistDia, lerCsv, lerFundamentos } from './lib.mjs';
import { atualizarUniverso, atualizarProventos } from './eventos.mjs';

const SAIDA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const modo = process.argv[2] || 'tudo';
const UA = { 'User-Agent': 'PlanoB-Investimentos-dados/1.0 (uso educacional)' };

async function baixar(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return Buffer.from(await r.arrayBuffer());
}

async function d1() {
  const hoje = new Date();
  for (let i = 1; i <= 10; i++) {
    const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - i));
    if ([0, 6].includes(d.getUTCDay())) continue;
    const url = urlCotahistDia(d);
    try {
      const zip = lerZip(await baixar(url)), arq = [...zip.keys()][0];
      const { data, precos } = lerCotahist(zip.get(arq).toString('latin1'));
      const n = Object.keys(precos).length;
      if (n < 100) { console.warn('poucos ativos em', url, n); continue; }
      fs.writeFileSync(path.join(SAIDA, 'd1.json'), JSON.stringify({ data, fonte: 'B3, cotações históricas (D-1)', p: precos }));
      console.log('d1 ok:', data, n, 'ativos');
      return;
    } catch (e) { console.warn('sem arquivo:', e.message); }
  }
  throw new Error('nenhum arquivo de fechamento encontrado nos últimos 10 dias');
}

/* ---------- maiores altas e quedas (último pregão x pregão anterior) ---------- */
async function bolsa(hojeBR = false) {
  let listas = {};
  try { listas = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'listas-bolsa.json'), 'utf8')); }
  catch (e) { throw new Error('não consegui ler listas-bolsa.json: ' + e.message); }
  const conj = (a) => new Set((a || []).map((x) => String(x).trim().toUpperCase()));
  const tijolo = conj(listas.fiisTijolo), papel = conj(listas.fiisPapel), etfs = conj(listas.etfs);
  const f = Object.assign({ minVolumeAcoes: 3000000, minVolumeFiis: 400000, minVolumeEtfs: 400000, minNegocios: 100, variacaoMaxima: 40, quantos: 5 }, listas.filtros || {});

  /* acha os dois últimos pregões disponíveis (o mais recente e o anterior) */
  /* modo normal: começa no dia anterior (UTC). modo "hoje": começa no dia de hoje em Brasília (UTC-3), usado no aviso das 19h */
  const hoje = hojeBR ? (process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T15:00:00Z') : new Date(Date.now() - 3 * 3600 * 1000)) : new Date(), dias = [];
  for (let i = hojeBR ? 0 : 1; i <= 14 && dias.length < 2; i++) {
    const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - i));
    if ([0, 6].includes(d.getUTCDay())) continue;
    try {
      const zip = lerZip(await baixar(urlCotahistDia(d))), arq = [...zip.keys()][0];
      const r = lerCotahistBolsa(zip.get(arq).toString('latin1'));
      if (Object.keys(r.itens).length < 100) { console.warn('bolsa: poucos ativos em', r.data); continue; }
      dias.push(r);
    } catch (e) { /* feriado ou arquivo ainda não publicado: tenta o dia anterior */ }
  }
  if (dias.length < 2) throw new Error('bolsa: não achei dois pregões consecutivos nos últimos 14 dias');
  const [hojeD, antesD] = dias;

  const monta = (filtro, minVol) => {
    const lista = [];
    for (const [tk, a] of Object.entries(hojeD.itens)) {
      const b = antesD.itens[tk];
      if (!b || !filtro(tk, a)) continue;
      if (a.vol < minVol || a.neg < f.minNegocios) continue;
      const v = (a.c / b.c - 1) * 100;
      if (!isFinite(v) || Math.abs(v) > f.variacaoMaxima) { if (isFinite(v)) console.warn('bolsa: ignorado por variação extrema (possível desdobramento ou evento):', tk, v.toFixed(1) + '%'); continue; }
      lista.push({ t: tk, n: a.nome, p: a.c, v: Math.round(v * 100) / 100 });
    }
    const alt = [...lista].sort((x, y) => y.v - x.v).filter((x) => x.v > 0).slice(0, f.quantos);
    const que = [...lista].sort((x, y) => x.v - y.v).filter((x) => x.v < 0).slice(0, f.quantos);
    return { altas: alt, quedas: que, universo: lista.length };
  };
  const ehBdr = (a) => /^DR/.test(a.esp);
  const saida = {
    data: hojeD.data, ref: antesD.data, fonte: 'B3, cotações históricas',
    acoes: monta((tk, a) => a.bdi === '02' && !ehBdr(a) && !tijolo.has(tk) && !papel.has(tk) && !etfs.has(tk), f.minVolumeAcoes),
    etfs: monta((tk) => etfs.has(tk), f.minVolumeEtfs),
    fiisTijolo: monta((tk) => tijolo.has(tk), f.minVolumeFiis),
    fiisPapel: monta((tk) => papel.has(tk), f.minVolumeFiis),
  };
  /* ETFs em destaque (ex.: ETHY11 e COIN11): abertura, fechamento e variação, mesmo fora do ranking */
  saida.destaque = ETFS_DESTAQUE.map((tk) => {
    const a = hojeD.itens[tk], b = antesD.itens[tk];
    if (!a) return null;
    return { t: tk, ab: a.ab, p: a.c, max: a.max, min: a.min, v: b ? Math.round((a.c / b.c - 1) * 10000) / 100 : null };
  }).filter(Boolean);
  /* referência do Ibovespa: o ETF BOVA11 (o índice em si não vem nesse arquivo) */
  const bv = hojeD.itens.BOVA11, bva = antesD.itens.BOVA11;
  if (bv && bva) saida.ibov = { t: 'BOVA11', p: bv.c, v: Math.round((bv.c / bva.c - 1) * 10000) / 100 };
  fs.writeFileSync(path.join(SAIDA, 'bolsa.json'), JSON.stringify(saida));
  console.log('bolsa ok:', saida.data, 'x', saida.ref, '| universo ações', saida.acoes.universo, 'etfs', saida.etfs.universo, 'tijolo', saida.fiisTijolo.universo, 'papel', saida.fiisPapel.universo);
  /* cadastro de códigos: novos, retirados e mudanças de código (não pode derrubar o ranking) */
  try {
    await atualizarUniverso(SAIDA, hojeD, async () => {
      const base = new Date(hojeD.data + 'T12:00:00Z'), out = [];
      for (let i = 1; i <= 45 && out.length < 25; i++) {
        const d = new Date(base.getTime() - i * 86400000);
        if ([0, 6].includes(d.getUTCDay())) continue;
        try { const zip = lerZip(await baixar(urlCotahistDia(d))), arq = [...zip.keys()][0]; const r = lerCotahistBolsa(zip.get(arq).toString('latin1')); if (Object.keys(r.itens).length >= 100) out.unshift(r); } catch (e) { /* feriado */ }
      }
      return out;
    });
  } catch (e) { console.warn('aviso universo:', e.message); }
  /* avisa se alguma lista ficou vazia (sinal de lista desatualizada ou filtro muito alto) */
  for (const k of ['acoes', 'etfs', 'fiisTijolo', 'fiisPapel']) if (!saida[k].altas.length && !saida[k].quedas.length) console.warn('aviso bolsa: nenhum ativo em', k);
}

async function fund() {
  const ano = new Date().getUTCFullYear(), base = 'https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/';
  const juntar = (zips, padrao) => {
    let linhas = [];
    zips.forEach((z) => z.forEach((buf, nome) => { if (padrao.test(nome)) linhas = linhas.concat(lerCsv(buf)); }));
    return linhas;
  };
  const dfp = [], fca = [];
  for (const y of [ano, ano - 1, ano - 2]) {
    try { dfp.push(lerZip(await baixar(base + 'DFP/DADOS/dfp_cia_aberta_' + y + '.zip'))); } catch (e) { console.warn('dfp', y, e.message); }
  }
  for (const y of [ano, ano - 1]) {
    try { fca.push(lerZip(await baixar(base + 'FCA/DADOS/fca_cia_aberta_' + y + '.zip'))); } catch (e) { console.warn('fca', y, e.message); }
  }
  if (!dfp.length || !fca.length) throw new Error('não foi possível baixar os arquivos da CVM');
  /* individual primeiro e consolidado depois: o consolidado vence quando a empresa tem os dois */
  const dre = juntar(dfp, /DRE_ind_/i).concat(juntar(dfp, /DRE_con_/i)), bpp = juntar(dfp, /BPP_ind_/i).concat(juntar(dfp, /BPP_con_/i)), capital = juntar(dfp, /composicao_capital/i);
  const fcaL = juntar(fca, /valor_mobiliario/i);
  console.log('linhas:', { dre: dre.length, bpp: bpp.length, capital: capital.length, fca: fcaL.length });
  const marca = (l, tipo) => l.map((r) => Object.assign(r, { _T: tipo }));
  const dfc = marca(juntar(dfp, /DFC_MD_ind_/i).concat(juntar(dfp, /DFC_MI_ind_/i)), 'ind').concat(marca(juntar(dfp, /DFC_MD_con_/i).concat(juntar(dfp, /DFC_MI_con_/i)), 'con'));
  /* diagnóstico: amostra bruta de algumas empresas, para conferir escalas e códigos de conta */
  try {
    const diag = {}, norm2 = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    for (const tk of ['ITUB4', 'BBSE3', 'BBAS3', 'WEGE3', 'CMIG4', 'VALE3']) {
      const f = fcaL.find((r) => String(r.CODIGO_NEGOCIACAO || '').includes(tk));
      if (!f) { diag[tk] = 'sem FCA'; continue; }
      const c = f.CNPJ_COMPANHIA || f.CNPJ_CIA;
      const pega = (l, fn) => l.filter((r) => r.CNPJ_CIA === c && fn(r)).slice(-8).map((r) => ({ d: r.DT_REFER, v: r.VERSAO, o: r.ORDEM_EXERC, c: r.CD_CONTA, n: r.DS_CONTA, e: r.ESCALA_MOEDA, m: r.MOEDA, x: r.VL_CONTA }));
      diag[tk] = {
        cnpj: c,
        lpa: pega(dre, (r) => /^3\.99/.test(r.CD_CONTA)),
        pl: pega(bpp, (r) => r.CD_CONTA === '2.03' || r.CD_CONTA === '2.03.09'),
        capital: capital.filter((r) => r.CNPJ_CIA === c).slice(-3),
        dfc: dfc.filter((r) => r.CNPJ_CIA === c && norm2(r.DS_CONTA).includes('DIVIDEND') || r.CNPJ_CIA === c && norm2(r.DS_CONTA).includes('JUROS SOBRE O CAPITAL')).filter((r) => r.ORDEM_EXERC && /LTIMO/.test(r.ORDEM_EXERC)).slice(-12).map((r) => ({ d: r.DT_REFER, v: r.VERSAO, c: r.CD_CONTA, n: r.DS_CONTA, e: r.ESCALA_MOEDA, x: r.VL_CONTA })),
      };
    }
    fs.writeFileSync(path.join(SAIDA, 'diagnostico.json'), JSON.stringify(diag, null, 1));
  } catch (e) { console.warn('diagnóstico falhou:', e.message); }
  let precos = {};
  try { precos = JSON.parse(fs.readFileSync(path.join(SAIDA, 'd1.json'), 'utf8')).p || {}; } catch (e) { console.warn('sem d1.json para conferir a escala; usando o lucro por ação'); }
  const debug = { tickers: ['CMIG4', 'BBSE3', 'ITUB4', 'BBAS3', 'WEGE3'] };
  const itens = lerFundamentos({ dre, bpp, capital, fca: fcaL, dfc, precos, debug });
  try { delete debug.tickers; fs.writeFileSync(path.join(SAIDA, 'diagnostico2.json'), JSON.stringify(debug, null, 1)); } catch (e) { /* ignora */ }
  const n = Object.keys(itens).length;
  if (n < 50) throw new Error('poucos ativos com fundamentos (' + n + '): confira os nomes das colunas da CVM');
  fs.writeFileSync(path.join(SAIDA, 'fundamentos.json'), JSON.stringify({ gerado: new Date().toISOString().slice(0, 10), fonte: 'CVM, dados abertos (DFP e FCA)', itens }));
  console.log('fundamentos ok:', n, 'ativos');
}

async function bcb() {
  /* Selic meta e CDI anualizado do Banco Central (SGS), usados pelo comparador de renda fixa.
     A API do Banco Central às vezes responde erro (500) ou uma página HTML de forma passageira;
     por isso cada taxa tem mais de uma série/forma de consulta e várias tentativas. */
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const SGS = (serie, n) => 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.' + serie + '/dados/ultimos/' + n + '?formato=json';
  const ler = (j, conv) => {
    const x = Array.isArray(j) && j.length ? j[j.length - 1] : null;
    const m = x && String(x.data).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    let v = x && parseFloat(String(x.valor).replace(',', '.'));
    if (m && v > 0 && conv) v = conv(v);
    if (!m || !(v > 0 && v < 60)) return null;
    return { data: m[3] + '-' + m[2] + '-' + m[1], valor: Math.round(v * 100) / 100 };
  };
  const anual = (d) => (Math.pow(1 + d / 100, 252) - 1) * 100; /* CDI diário (% ao dia) para % ao ano, base 252 */
  const buscar = async (fontes) => {
    let erro = 'sem resposta';
    for (let t = 0; t < 2; t++) {
      for (const f of fontes) {
        try {
          const r = await fetch(f.url, { headers: Object.assign({ Accept: 'application/json' }, UA), signal: AbortSignal.timeout(10000) });
          const txt = await r.text();
          let j = null; try { j = JSON.parse(txt); } catch (e) { /* não é JSON */ }
          const ok = r.ok && ler(j, f.conv);
          if (ok) return Object.assign(ok, { fonte: f.nome });
          erro = f.nome + ': HTTP ' + r.status + ' ' + txt.slice(0, 100).replace(/\s+/g, ' ');
        } catch (e) { erro = f.nome + ': ' + e.message; }
      }
      if (t < 1) await espera(1000);
    }
    throw new Error(erro);
  };
  const selic = await buscar([{ nome: 'Selic meta (432)', url: SGS(432, 1) }, { nome: 'Selic meta (432)', url: SGS(432, 5) }]);
  const cdi = await buscar([{ nome: 'CDI (4389)', url: SGS(4389, 1) }, { nome: 'CDI (4389)', url: SGS(4389, 5) }, { nome: 'Selic anualizada (1178)', url: SGS(1178, 5) }, { nome: 'CDI diário (12)', url: SGS(12, 5), conv: anual }]);
  /* a série 432 pode trazer datas futuras (a meta já decidida pelo Copom): a data da taxa é a do CDI */
  fs.writeFileSync(path.join(SAIDA, 'bcb.json'), JSON.stringify({ gerado: new Date().toISOString().slice(0, 10), data: cdi.data, selic: selic.valor, selicData: selic.data, cdi: cdi.valor, fonte: 'Banco Central do Brasil (SGS: ' + selic.fonte + '; ' + cdi.fonte + ')' }));
  console.log('bcb ok: Selic', selic.valor, 'CDI', cdi.valor, cdi.data, '(' + cdi.fonte + ')');
}

let falhou = false;
if (modo === 'd1' || modo === 'tudo') await d1().catch((e) => { console.error('ERRO d1:', e.message); falhou = true; });
/* o Banco Central falhar não deve impedir a atualização dos outros dados */
if (modo === 'd1' || modo === 'tudo' || modo === 'bcb') await bcb().catch((e) => { console.warn('aviso bcb:', e.message); });
/* idem para o ranking da bolsa */
if (modo === 'bolsa-hoje') await bolsa(true).catch((e) => { console.warn('aviso bolsa:', e.message); });
if (modo === 'd1' || modo === 'tudo' || modo === 'bolsa') await bolsa().catch((e) => { console.warn('aviso bolsa:', e.message); });
/* proventos (experimental): FIIs pelo FNET e ações pelo site da B3; falhar não derruba nada */
if (modo === 'proventos') {
  const hojeBR = process.env.DATA_TESTE ? process.env.DATA_TESTE : new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  await atualizarProventos(SAIDA, hojeBR).catch((e) => { console.warn('aviso proventos:', e.message); });
}
if (modo === 'fund' || modo === 'tudo') await fund().catch((e) => { console.error('ERRO fundamentos:', e.message); falhou = true; });
process.exit(falhou ? 1 : 0);
