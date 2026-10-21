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

  /* 4) consulta de verdade: os 17 parâmetros que o JavaScript da própria página envia (descobertos na 1ª sonda). Últimos 3 dias, todas as categorias. */
  const brt = (d) => { const x = new Date(Date.now() - 3 * 3600 * 1000 - d * 86400000); return String(x.getUTCDate()).padStart(2, '0') + '/' + String(x.getUTCMonth() + 1).padStart(2, '0') + '/' + x.getUTCFullYear(); };
  const base = { dataDe: brt(3), dataAte: brt(0), empresa: '', dataReferencia: '', categoria: '', periodo: '2', horaIni: '', horaFim: '', palavraChave: '', ultimaDtRef: 'false', tipoEmpresa: '0', token: '', versaoCaptcha: '' };
  const variantes = { combos_menos1: { setorAtividade: '-1', categoriaEmissor: '-1', situacaoEmissor: '-1', tipoParticipante: '-1' }, combos_vazios: { setorAtividade: '', categoriaEmissor: '', situacaoEmissor: '', tipoParticipante: '' } };
  for (const [nome, extra] of Object.entries(variantes)) {
    try {
      const { r, t } = await buscar(BASE + 'frmConsultaExternaCVM.aspx/ListarDocumentos', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, UA), body: JSON.stringify(Object.assign({}, base, extra)) });
      let j = null; try { j = JSON.parse(t); } catch (e) { /* não é JSON */ }
      let d = j && j.d; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { /* texto puro */ } }
      const info = { status: r.status, tipo: r.headers.get('content-type'), chaves_d: d && typeof d === 'object' ? Object.keys(d) : typeof d, bytes: t.length };
      if (d && typeof d === 'object') {
        info.temErro = d.temErro; info.msgErro = d.msgErro; info.SolicitarCaptcha = d.SolicitarCaptcha;
        const dados = typeof d.dados === 'string' ? d.dados : '';
        const linhas = dados ? dados.split('&*').filter(Boolean) : [];
        info.total_linhas = linhas.length;
        info.exemplo_linhas = linhas.slice(0, 12).map((l) => l.split('$&').map((c) => c.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)));
        info.exemplo_linha_bruta = linhas[0] ? linhas[0].slice(0, 1500) : null;
        const cats = {}; for (const l of linhas) { const c = (l.split('$&')[2] || '').replace(/<[^>]*>/g, '').trim(); cats[c] = (cats[c] || 0) + 1; }
        info.categorias_na_resposta = cats;
      } else info.inicio = t.slice(0, 500).replace(/\s+/g, ' ');
      passo('consulta_' + nome, info);
    } catch (e) { passo('consulta_' + nome, { erro: e.message }); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  /* 5) lista de categorias (códigos usados no filtro "categoria", ex.: Fato Relevante) */
  for (const metodo of ['PopularComboCategoria', 'MontarCombosCategoriaTipoEspecie']) {
    try {
      const { r, t } = await buscar(BASE + 'frmConsultaExternaCVM.aspx/' + metodo, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, UA), body: '{}' });
      passo('categorias_' + metodo, { status: r.status, bytes: t.length, inicio: t.slice(0, 1800).replace(/\s+/g, ' ') });
    } catch (e) { passo('categorias_' + metodo, { erro: e.message }); }
    await new Promise((r) => setTimeout(r, 1500));
  }

  /* 6) fontes de juros: Tesouro Direto (taxas do dia, como no print do Alex Economia) e juros futuros (DI) */
  const fontesJuros = {
    tesouro_direto_json: ['GET', 'https://www.tesourodireto.com.br/json/br/com/b3/tesourodireto/service/api/treasurybondsinfo.json'],
    tesouro_transparente_csv: ['HEAD', 'https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/precotaxatesourodireto.csv'],
    b3_ajustes_pregao: ['GET', 'https://www2.bmf.com.br/pages/portal/bmfbovespa/lumis/lum-ajustes-do-pregao-ptBR.asp'],
    b3_curva_di_pre: ['GET', 'https://www2.bmf.com.br/pages/portal/bmfbovespa/boletim1/TxRef1.asp']
  };
  for (const [nome, [metodo, url]] of Object.entries(fontesJuros)) {
    try {
      const { r, t } = await buscar(url, { method: metodo, headers: UA });
      passo('juros_' + nome, { status: r.status, tipo: r.headers.get('content-type'), modificado: r.headers.get('last-modified'), bytes: t.length, inicio: t.slice(0, 700).replace(/\s+/g, ' ') });
    } catch (e) { passo('juros_' + nome, { erro: e.message }); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  try { /* TradingView: futuros de DI (juros futuros), cotação ~15 min de atraso */
    const corpo = { filter: [{ left: 'name', operation: 'match', right: 'DI1' }], columns: ['name', 'description', 'close', 'change', 'change_abs', 'expiration'], range: [0, 40], sort: { sortBy: 'name', sortOrder: 'asc' } };
    const { r, t } = await buscar('https://scanner.tradingview.com/futures/scan', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, UA), body: JSON.stringify(corpo) });
    passo('juros_tradingview_di1', { status: r.status, bytes: t.length, inicio: t.slice(0, 1500).replace(/\s+/g, ' ') });
  } catch (e) { passo('juros_tradingview_di1', { erro: e.message }); }
} catch (e) { diag.erro = e.message; console.error('ERRO:', e.message); }
fs.mkdirSync(SAIDA, { recursive: true });
fs.writeFileSync(path.join(SAIDA, 'sonda-cvm.json'), JSON.stringify(diag, null, 1));
console.log('sonda gravada em saida/sonda-cvm.json');
