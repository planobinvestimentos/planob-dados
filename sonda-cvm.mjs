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
    passo('enet_pagina', { status: r.status, tipo: r.headers.get('content-type'), bytes: t.length, inicio: t.slice(0, 200).replace(/\s+/g, ' ') });
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
} catch (e) { diag.erro = e.message; console.error('ERRO:', e.message); }
fs.mkdirSync(SAIDA, { recursive: true });
fs.writeFileSync(path.join(SAIDA, 'sonda-cvm.json'), JSON.stringify(diag, null, 1));
console.log('sonda gravada em saida/sonda-cvm.json');
