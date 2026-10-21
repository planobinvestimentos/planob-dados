/* SONDA (só leitura): descobre como pegar comunicados de empresas EM TEMPO REAL, já que o arquivo aberto da CVM (IPE) só é atualizado 1 vez por semana.
   Roda só à mão (Actions > "Sonda da CVM" > Run workflow). Faz poucas consultas a páginas públicas e grava o resultado em saida/sonda-cvm.json.
   Não envia nada ao Telegram e não altera nenhum outro arquivo. Depois de rodar, avise o Claude ("rodei") para ele ler o resultado. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.join(RAIZ, 'saida');
const BASE = process.env.CVM_ENET_BASE || 'https://www.rad.cvm.gov.br/ENETWeb/';
const IPE = process.env.CVM_IPE_URL || 'https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/IPE/DADOS/ipe_cia_aberta_2026.zip';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; PlanoB-Investimentos-sonda/1.0; uso educacional)', Accept: 'text/html,application/json,*/*' };
const diag = { gerado: new Date().toISOString(), passos: [] };
const passo = (nome, dados) => { diag.passos.push(Object.assign({ nome }, dados)); console.log(nome, JSON.stringify(dados).slice(0, 300)); };
const buscar = async (url, opc = {}) => {
  const r = await fetch(url, Object.assign({ headers: UA, signal: AbortSignal.timeout(25000), redirect: 'follow' }, opc));
  const t = await r.text();
  return { r, t };
};
const PADROES = [
  /["'`]([^"'`\s]*\.aspx[^"'`\s]*)["'`]/g,
  /["'`]([^"'`\s]*(?:ListarDocumentos|ConsultarDocumentos|ListaDocumentos|frmDownloadDocumento|downloadDocumento|BuscarDocumentos)[^"'`\s]*)["'`]/gi,
  /url\s*:\s*["'`]([^"'`]+)["'`]/g,
  /\$\.(?:ajax|post|getJSON)\s*\(\s*["'`]?([^"'`,)\s]+)/g,
];
const achar = (texto) => {
  const out = new Set();
  for (const re of PADROES) { re.lastIndex = 0; let m; while ((m = re.exec(texto)) && out.size < 60) out.add(m[1]); }
  return [...out];
};
const trechos = (texto, chaves, tam = 350) => {
  const out = [];
  for (const k of chaves) { let i = -1, n = 0; while ((i = texto.toLowerCase().indexOf(k.toLowerCase(), i + 1)) >= 0 && n < 3) { out.push(texto.slice(Math.max(0, i - 120), i + tam).replace(/\s+/g, ' ')); n++; } }
  return out.slice(0, 6);
};

try {
  /* 1) arquivo aberto da CVM: quando foi atualizado pela última vez */
  try {
    const r = await fetch(IPE, { method: 'HEAD', headers: UA, signal: AbortSignal.timeout(20000) });
    passo('ipe_zip', { status: r.status, last_modified: r.headers.get('last-modified'), tamanho: r.headers.get('content-length') });
  } catch (e) { passo('ipe_zip', { erro: e.message }); }

  /* 2) página de consulta externa da CVM (ENETWeb): quais scripts e endereços ela usa */
  let html = '';
  try {
    const { r, t } = await buscar(BASE + 'frmConsultaExternaCVM.aspx');
    html = t;
    const hid = (id) => { const m = t.match(new RegExp('id=["\']' + id + '["\'][^>]*?value=["\']([^"\']*)["\']', 'i')) || t.match(new RegExp('value=["\']([^"\']*)["\'][^>]*?id=["\']' + id + '["\']', 'i')); return m ? m[1] : null; };
    passo('enet_pagina', { status: r.status, tipo: r.headers.get('content-type'), bytes: t.length, hdnHabilitaCaptcha: hid('hdnHabilitaCaptcha'), tem_chave_v3: !!hid('hdnChaveSiteV3'), tem_chave_v2: !!hid('hdnChaveSiteV2') });
  } catch (e) { passo('enet_pagina', { erro: e.message }); }

  if (html) {
    const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
    passo('enet_scripts', { lista: srcs });
    passo('enet_enderecos_na_pagina', { enderecos: achar(html), trechos: trechos(html, ['ajax', 'ListarDocumentos', 'DataTable(']) });
    const proprios = srcs.filter((s) => !/jquery|datatables|bootstrap|pdfjs|moment|popper|modernizr/i.test(s)).slice(0, 8);
    for (const s of proprios) {
      try {
        const u = new URL(s, BASE).href;
        const { r, t } = await buscar(u);
        passo('enet_script_' + path.basename(new URL(u).pathname), { url: u, status: r.status, bytes: t.length, enderecos: achar(t.slice(0, 400000)), trechos: trechos(t.slice(0, 400000), ['ListarDocumentos', '$.ajax', 'dataSrc']) });
      } catch (e) { passo('enet_script', { url: s, erro: e.message }); }
    }
    /* 3) chute educado: alguns sistemas ASP.NET expõem o método em /pagina.aspx/Metodo; só olha o status */
    for (const metodo of ['ListarDocumentos', 'ConsultarDocumentos']) {
      try {
        const { r, t } = await buscar(BASE + 'frmConsultaExternaCVM.aspx/' + metodo, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, UA), body: '{}' });
        passo('chute_' + metodo, { status: r.status, tipo: r.headers.get('content-type'), inicio: t.slice(0, 250).replace(/\s+/g, ' ') });
      } catch (e) { passo('chute_' + metodo, { erro: e.message }); }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  /* 4) documentos "eventuais" (IPE: Fato Relevante, Comunicado, Aviso aos Acionistas, Proventos): amostras reais, datas, e teste de download.
        Resultado da 1ª rodada: a consulta funciona sem captcha (852 documentos em 3 dias). Aqui olhamos o formato das linhas de IPE. */
  const brt = (d) => { const x = new Date(Date.now() - 3 * 3600 * 1000 - d * 86400000); return String(x.getUTCDate()).padStart(2, '0') + '/' + String(x.getUTCMonth() + 1).padStart(2, '0') + '/' + x.getUTCFullYear(); };
  const limpa = (c) => String(c || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const post = async (metodo, corpo) => buscar(BASE + 'frmConsultaExternaCVM.aspx/' + metodo, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, UA), body: JSON.stringify(corpo) });
  const parse = (t) => { let j = null; try { j = JSON.parse(t); } catch (e) { /* ignora */ } let d = j && j.d; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { /* texto puro */ } } return d; };
  let catIds = {};
  try { /* códigos das categorias de IPE (ex.: IPE_4_-1_-1 = Fato Relevante) */
    const { r, t } = await post('MontarCombosCategoriaTipoEspecie', {});
    const htm = String((parse(t) || '')).replace(/&#160;/g, ' ').replace(/&amp;/g, '&');
    for (const m of htm.matchAll(/<option value="(IPE_[^"]+)"[^>]*>([^<]*)<\/option>/g)) { const nome = limpa(m[2]); if (/fato relevante|aviso aos acionistas|comunicado ao mercado|proventos|calend[aá]rio de eventos/i.test(nome) && /\|\s*TODOS\s*\|\s*TODAS/i.test(nome)) catIds[m[1]] = nome; }
    passo('ipe_codigos_categorias', { status: r.status, achados: catIds, total_options: (htm.match(/<option /g) || []).length });
  } catch (e) { passo('ipe_codigos_categorias', { erro: e.message }); }
  await new Promise((r) => setTimeout(r, 1500));
  const base = { dataDe: brt(2), dataAte: brt(0), empresa: '', dataReferencia: '', categoria: 'IPE_-1_-1_-1', periodo: '2', horaIni: '', horaFim: '', palavraChave: '', ultimaDtRef: 'false', tipoEmpresa: '0', token: '', versaoCaptcha: '', setorAtividade: '-1', categoriaEmissor: '-1', situacaoEmissor: '-1', tipoParticipante: '-1' };
  let linhasIPE = [];
  try {
    const { r, t } = await post('ListarDocumentos', base);
    const d = parse(t);
    const dados = d && typeof d.dados === 'string' ? d.dados : '';
    linhasIPE = dados.split('&*').filter(Boolean).map((l) => l.split('$&'));
    const porData = {}, porCat = {}, tamanhos = {};
    for (const c of linhasIPE) { const dt = limpa(c[6]).split(' ')[1] || '?'; porData[dt] = (porData[dt] || 0) + 1; porCat[limpa(c[2])] = (porCat[limpa(c[2])] || 0) + 1; tamanhos[c.length] = (tamanhos[c.length] || 0) + 1; }
    const horas = linhasIPE.map((c) => limpa(c[6]).replace(/^\d+\s/, '')).sort();
    passo('ipe_consulta', { status: r.status, SolicitarCaptcha: d && d.SolicitarCaptcha, temErro: d && d.temErro, msgErro: d && d.msgErro, linhas: linhasIPE.length, por_data_entrega: porData, por_categoria: porCat, colunas_por_linha: tamanhos, entrega_mais_antiga: horas[0], entrega_mais_recente: horas[horas.length - 1], ordem_das_5_primeiras: linhasIPE.slice(0, 5).map((c) => limpa(c[6])) });
  } catch (e) { passo('ipe_consulta', { erro: e.message }); }
  /* 3 amostras brutas de cada tipo de interesse */
  const amostras = {};
  for (const c of linhasIPE) {
    const cat = limpa(c[2]);
    if (!/fato relevante|aviso aos acionistas|comunicado ao mercado|proventos/i.test(cat)) continue;
    amostras[cat] = amostras[cat] || [];
    if (amostras[cat].length < 3) amostras[cat].push({ campos: c.map((x, i) => (i === 10 ? String(x).slice(0, 700) : limpa(x).slice(0, 300))) });
  }
  passo('ipe_amostras', { amostras });
  /* download: monta o endereço como o JavaScript da página e baixa 1 Fato Relevante e 1 Comunicado */
  const alvo = [linhasIPE.find((c) => /fato relevante/i.test(c[2])), linhasIPE.find((c) => /comunicado ao mercado/i.test(c[2]))].filter(Boolean);
  for (const c of alvo) {
    try {
      const m = String(c[10] || '').match(/OpenDownloadDocumentos\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/);
      if (!m) { passo('ipe_download_' + limpa(c[2]).slice(0, 12), { erro: 'não achei OpenDownloadDocumentos na linha', coluna10: String(c[10] || '').slice(0, 400) }); continue; }
      const url = BASE + 'frmDownloadDocumento.aspx?Tela=ext&numSequencia=' + encodeURIComponent(m[1]) + '&numVersao=' + encodeURIComponent(m[2]) + '&numProtocolo=' + encodeURIComponent(m[3]) + '&descTipo=' + encodeURIComponent(m[4]) + '&CodigoInstituicao=1';
      const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(60000) });
      const buf = Buffer.from(await r.arrayBuffer());
      passo('ipe_download_' + limpa(c[2]).slice(0, 12), { empresa: limpa(c[1]), assunto: limpa(c[11]), url, status: r.status, tipo: r.headers.get('content-type'), disposicao: r.headers.get('content-disposition'), bytes: buf.length, comeca_com: buf.subarray(0, 8).toString('latin1').replace(/[^\x20-\x7e]/g, '.'), texto_inicio: /pdf/i.test(String(r.headers.get('content-type'))) ? '(PDF)' : buf.toString('latin1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300) });
    } catch (e) { passo('ipe_download', { erro: e.message }); }
    await new Promise((r) => setTimeout(r, 2000));
  }
} catch (e) { diag.erro = e.message; console.error('ERRO:', e.message); }
fs.mkdirSync(SAIDA, { recursive: true });
fs.writeFileSync(path.join(SAIDA, 'sonda-cvm.json'), JSON.stringify(diag, null, 1));
console.log('sonda gravada em saida/sonda-cvm.json');
