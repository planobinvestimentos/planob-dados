/* Eventos da B3 e proventos, usados pelo aviso diário do Telegram.
   1) atualizarUniverso: guarda os códigos já vistos na B3 e acha novos, retirados e mudanças de código
      (mudança de código = mesmo código ISIN com ticker novo).
   2) proventosFii: avisos de rendimentos dos FIIs (B3, FNET, "Aviso aos Cotistas - Estruturado").
   3) proventosAcoes: dividendos e JCP das ações (site da B3, empresas listadas).
   As partes 2 e 3 dependem de endereços não documentados da B3: se algo mudar, elas falham sem
   derrubar o resto, e deixam um arquivo de diagnóstico em saida/proventos-diag.json. */
import fs from 'node:fs';
import path from 'node:path';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; PlanoB-Investimentos-dados/1.0; uso educacional)', Accept: 'application/json, text/plain, */*' };
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const lerJson = (arq, pad) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { return pad; } };

/* ---------- classificação pelo código BDI do arquivo da B3 ---------- */
export function classe(a) {
  if (a.bdi === '12') return 'FII';
  if (a.bdi === '14') return 'ETF';
  if (a.bdi === '02' && !/^DR/.test(a.esp || '')) return 'Ação';
  return null;
}
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);

/* aplica um dia de negociação ao cadastro e devolve o que mudou */
function aplicarDia(u, r) {
  const ev = { novos: [], codigo: [], sairam: [] };
  const porIsin = {};
  for (const [tk, it] of Object.entries(u.itens)) if (it.isin) porIsin[it.isin] = tk;
  for (const tk of Object.keys(r.itens).sort()) {
    const a = r.itens[tk], cls = classe(a);
    if (!cls) continue;
    const it = u.itens[tk];
    if (!it) {
      const antigo = a.isin && porIsin[a.isin];
      if (antigo && antigo !== tk) { ev.codigo.push({ de: antigo, para: tk, nome: a.nome, cls }); u.itens[antigo].trocouPara = tk; }
      else ev.novos.push({ t: tk, nome: a.nome, cls });
      u.itens[tk] = { isin: a.isin || '', nome: a.nome, cls, primeira: r.data, ultima: r.data };
    } else {
      it.ultima = r.data;
      if (a.nome) it.nome = a.nome;
      if (!it.isin && a.isin) it.isin = a.isin;
      delete it.sumiu;
    }
  }
  /* sem negociação há 30 dias corridos (cerca de 20 pregões): possível retirada */
  for (const [tk, it] of Object.entries(u.itens)) {
    if (it.sumiu || it.trocouPara) continue;
    if (diasEntre(it.ultima, r.data) >= 30) { it.sumiu = r.data; ev.sairam.push({ t: tk, nome: it.nome, cls: it.cls, ultima: it.ultima }); }
  }
  u.data = r.data;
  return ev;
}

/* semente: função que devolve os pregões anteriores (do mais antigo ao mais novo), usada só na 1ª vez */
export async function atualizarUniverso(saida, hojeD, semente) {
  const arqU = path.join(saida, 'universo.json'), arqE = path.join(saida, 'eventos.json');
  let u = lerJson(arqU, null), criado = false;
  if (!u) {
    u = { data: '', itens: {} };
    for (const r of await semente()) aplicarDia(u, r);
    criado = true;
  }
  if (u.data && hojeD.data <= u.data && !criado) return;             // este dia já foi processado
  const ev = aplicarDia(u, hojeD);
  fs.writeFileSync(arqU, JSON.stringify(u));
  /* na criação da base não há como separar "novo" de "pouco negociado": só guarda a base */
  const saidaEv = criado ? { data: hojeD.data, base: true, novos: [], codigo: [], sairam: [] } : Object.assign({ data: hojeD.data }, ev);
  fs.writeFileSync(arqE, JSON.stringify(saidaEv));
  console.log('universo ok:', hojeD.data, criado ? '(base criada com ' + Object.keys(u.itens).length + ' códigos)' : 'novos ' + ev.novos.length + ', código ' + ev.codigo.length + ', retirados ' + ev.sairam.length);
}

/* ---------- utilidades de rede e de texto ---------- */
async function pegar(url, { json = false, tentativas = 2, ms = 30000 } = {}) {
  let erro;
  for (let t = 0; t < tentativas; t++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      return json ? JSON.parse(txt) : txt;
    } catch (e) { erro = e; await dorme(800); }
  }
  throw erro;
}
const dataBR = (s) => {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[3] + '/' + m[2] + '/' + m[1];
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? m[0] : '';
};
const dataISO = (br) => { const m = String(br || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; };
const numero = (s) => { s = String(s == null ? '' : s).trim(); if (!s) return NaN; return s.includes(',') ? parseFloat(s.replace(/\./g, '').replace(',', '.')) : parseFloat(s); };
const paraIso = (d) => d.toISOString().slice(0, 10);

/* ---------- FIIs: avisos de rendimentos e amortizações (FNET) ---------- */
export function lerAvisoFii(xml) {
  xml = String(xml || '').replace(/^﻿/, '').trim();
  if (xml && !xml.includes('<')) { try { xml = Buffer.from(xml.replace(/^"|"$/g, ''), 'base64').toString('utf8'); } catch (e) { /* segue com o texto original */ } }
  const folhas = [...xml.matchAll(/<([A-Za-z_][\w.:-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g)].map((m) => ({ k: m[1].replace(/^.*:/, '').toLowerCase(), v: m[2].trim() }));
  const itens = [];
  let cod = '', rec = {};
  const fecha = () => {
    if (rec.v > 0 && rec.pag) itens.push({ t: rec.t || cod, tipo: rec.tipo || 'Rendimento', v: rec.v, base: rec.base || '', pag: rec.pag });
    rec = {};
  };
  const poe = (k, v) => { if (rec[k] !== undefined) fecha(); rec[k] = v; };
  for (const f of folhas) {
    if (/^cod(igo)?(de)?negocia/.test(f.k)) { if (/^[A-Z]{4}\d{1,2}$/.test(f.v)) cod = f.v; }
    else if (f.k === 'database') poe('base', dataBR(f.v));
    else if (f.k === 'datapagamento') poe('pag', dataBR(f.v));
    else if (/^valor(provento|porcota)/.test(f.k) || f.k === 'valorrendimento' || f.k === 'valoramortizacao') {
      const v = numero(f.v);
      if (v > 0) { poe('v', v); if (f.k === 'valoramortizacao') rec.tipo = 'Amortização'; }
    } else if (/^tipo/.test(f.k) && /amortiz/i.test(f.v)) rec.tipo = 'Amortização';
  }
  fecha();
  if (!cod) { const m = xml.match(/\b[A-Z]{4}1[1-3]\b/); if (m) cod = m[0]; }
  for (const i of itens) if (!i.t) i.t = cod;
  return itens.filter((i) => /^[A-Z]{4}\d{1,2}$/.test(i.t));
}

export async function proventosFii({ de, ate, anterior = [], vistos = new Set(), diag, max = 400 }) {
  const base = process.env.FNET_URL || 'https://fnet.bmfbovespa.com.br/fnet/publico/';
  const url = base + 'pesquisarGerenciadorDocumentosDados?d=1&s=0&l=' + max + '&o%5B0%5D%5BdataEntrega%5D=desc&idCategoriaDocumento=14&idTipoDocumento=41&dataInicial=' + dataBR(de) + '&dataFinal=' + dataBR(ate);
  const lista = await pegar(url, { json: true });
  const docs = (lista.data || []).filter((d) => !d.status || /^A/i.test(d.status));
  diag.fii = { total: docs.length, campos: docs[0] ? Object.keys(docs[0]) : [], docs: [] };
  const itens = anterior.filter((x) => x.ent >= de);
  let baixados = 0, semItens = 0, falhas = 0;
  for (const d of docs) {
    if (vistos.has(d.id)) continue;
    const ent = dataISO(d.dataEntrega);
    try {
      const xml = await pegar(base + 'downloadDocumento?id=' + d.id, { tentativas: 2, ms: 30000 });
      const achados = lerAvisoFii(xml);
      baixados++;
      if (!achados.length) semItens++;
      for (const a of achados) itens.push(Object.assign(a, { id: d.id, ent, fundo: d.nomePregao || d.descricaoFundo || '' }));
      if (diag.fii.docs.length < 3) diag.fii.docs.push({ id: d.id, fundo: d.descricaoFundo, entrega: d.dataEntrega, inicio: String(xml).slice(0, 1800), lidos: achados });
      vistos.add(d.id);
    } catch (e) { falhas++; if (diag.fii.docs.length < 3) diag.fii.docs.push({ id: d.id, erro: e.message }); }
    await dorme(120);
  }
  Object.assign(diag.fii, { baixados, semItens, falhas, itens: itens.length });
  console.log('proventos FIIs:', docs.length, 'avisos na lista,', baixados, 'baixados,', semItens, 'sem dados lidos,', falhas, 'falhas,', itens.length, 'proventos');
  return itens;
}

/* ---------- Ações: dividendos e JCP (site da B3, por empresa) ---------- */
export async function proventosAcoes({ emissoras, isinParaTicker, de, diag, simultaneas = 4 }) {
  const base = process.env.B3_EMP_URL || 'https://sistemaswebb3-listados.b3.com.br/listedCompaniesProxy/CompanyCall/GetListedSupplementCompany/';
  const itens = [], vistos = new Set();
  let ok = 0, falhas = 0, semDividendos = 0, abortar = false;
  diag.acoes = { emissoras: emissoras.length, amostra: null };
  const um = async (cod) => {
    if (abortar) return;
    try {
      const j = await pegar(base + Buffer.from(JSON.stringify({ language: 'pt-br', issuingCompany: cod })).toString('base64'), { json: true, tentativas: 1, ms: 20000 });
      ok++;
      const arr = Array.isArray(j) ? j : [j];
      const caixa = arr.flatMap((x) => (x && x.cashDividends) || []);
      if (!diag.acoes.amostra && caixa.length) diag.acoes.amostra = { emissora: cod, campos: Object.keys(caixa[0]), primeiro: caixa[0] };
      if (!caixa.length) semDividendos++;
      for (const c of caixa) {
        const aprov = dataISO(c.approvedOn), tk = isinParaTicker[c.assetIssued || c.isinCode];
        const v = numero(c.rate);
        if (!tk || !(v > 0) || !aprov || aprov < de) continue;
        const tipo = /JRS|JCP|JUROS/i.test(c.label || '') ? 'JCP' : /DIVID/i.test(c.label || '') ? 'Dividendo' : String(c.label || 'Provento');
        const chave = [tk, tipo, c.lastDatePrior, c.paymentDate, v].join('|');
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        itens.push({ t: tk, tipo, v, base: dataBR(c.lastDatePrior), pag: dataBR(c.paymentDate), ent: aprov });
      }
    } catch (e) {
      falhas++;
      if (falhas >= 8 && ok === 0) { abortar = true; diag.acoes.erro = 'as primeiras consultas falharam (' + e.message + '): endereço bloqueado ou mudou'; }
    }
    await dorme(100);
  };
  const fila = [...emissoras];
  await Promise.all(Array.from({ length: simultaneas }, async () => { while (fila.length && !abortar) await um(fila.shift()); }));
  Object.assign(diag.acoes, { ok, falhas, semDividendos, itens: itens.length });
  console.log('proventos ações:', ok, 'empresas ok,', falhas, 'falhas,', itens.length, 'proventos recentes');
  return itens;
}

/* ---------- orquestra a atualização de proventos ---------- */
export async function atualizarProventos(saida, hoje) {
  const arq = path.join(saida, 'proventos.json');
  const ant = lerJson(arq, {});
  const de = paraIso(new Date(Date.parse(hoje + 'T12:00:00Z') - 2 * 86400000));
  const diag = { gerado: new Date().toISOString(), de, ate: hoje };
  const universo = lerJson(path.join(saida, 'universo.json'), { itens: {} });
  const isinParaTicker = {}, emissoras = new Set();
  for (const [tk, it] of Object.entries(universo.itens)) {
    if (it.isin) isinParaTicker[it.isin] = tk;
    if (it.cls === 'Ação' && !it.sumiu) emissoras.add(tk.slice(0, 4));
  }
  const saidaJ = { gerado: diag.gerado, de, fii: ant.fii || [], acoes: ant.acoes || [], docsVistos: ant.docsVistos || [] };
  const vistos = new Set(saidaJ.docsVistos);
  try { saidaJ.fii = await proventosFii({ de, ate: hoje, anterior: saidaJ.fii, vistos, diag }); }
  catch (e) { console.warn('aviso proventos FIIs:', e.message); diag.fii = { erro: e.message }; }
  if (emissoras.size) {
    try { saidaJ.acoes = await proventosAcoes({ emissoras: [...emissoras], isinParaTicker, de, diag }); }
    catch (e) { console.warn('aviso proventos ações:', e.message); diag.acoes = { erro: e.message }; }
  } else { diag.acoes = { erro: 'cadastro de códigos ainda vazio (rode o fechamento antes)' }; }
  saidaJ.docsVistos = [...vistos].slice(-2000);
  fs.writeFileSync(arq, JSON.stringify(saidaJ));
  fs.writeFileSync(path.join(saida, 'proventos-diag.json'), JSON.stringify(diag, null, 1));
}
