/* Aviso de proventos NA HORA (FIIs, ETFs em destaque, ações, JCP e bonificação) + relatório gerencial do FII, quando existir.
   Roda no GitHub Actions a cada 15 minutos em dias úteis, das 9h às 20h45 (e às 21h00 e 21h15, para a consulta das ações das 21h) (workflow proventos-agora.yml):  node proventos-agora.mjs
   Como funciona:
     1) Lê a lista de documentos recentes dos FIIs no FNET (B3). Quando aparece um "Aviso aos Cotistas" novo de um FII com liquidez acima
        de R$ 1 milhão/dia, busca o rendimento (primeiro no site da B3 para aquele fundo; se ainda não saiu lá, lê o próprio aviso do FNET).
     2) A cada ~1 hora varre os FIIs líquidos e os ETFs em destaque (para pegar o que o passo 1 não viu). As AÇÕES (dividendos, JCP e bonificação)
        são consultadas só 4 vezes por dia, perto das 12h, 16h, 20h e 21h (HORAS_ACOES), porque a B3 exige uma consulta por empresa (~280).
     3) Posta o que for novo no Telegram, uma única vez por provento. Se o FII tem relatório gerencial no FNET (entregue de 7 dias antes até agora),
        envia o PDF logo depois. Sem relatório, o provento sai do mesmo jeito.
   Só escreve em saida/agora.json (estado) e saida/agora-diag.json (diagnóstico); não mexe nos outros arquivos de saida.
   O resumo do dia às 21h (telegram.mjs, parte "resumo") lê saida/agora.json.
   Precisa de: saida/liquidez-fiis.json, saida/universo.json, saida/proventos.json (nomes dos fundos) e dos segredos TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.
   Opcionais: TESTE=1 (só mostra no log), FORCAR=1 (ignora horário e a pausa da varredura), FNET_URL, TELEGRAM_API, DATA_TESTE, HORA_TESTE. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atualizarProventos, proventosFiiB3, lerAvisoFii } from './eventos.mjs';
import { ETFS_DESTAQUE } from './lib.mjs';
import { msgProventos, chaveProvento, chaveAlt, enviarTexto, enviarPdf } from './proventos-msg.mjs';

const SAIDA = process.env.SAIDA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const TESTE = process.env.TESTE === '1';
const FORCAR = process.env.FORCAR === '1';
const FNET = process.env.FNET_URL || 'https://fnet.bmfbovespa.com.br/fnet/publico/';
const UA = { 'User-Agent': 'PlanoB-Investimentos-dados/1.0 (uso educacional)', Accept: 'application/json, text/plain, */*' };
const JANELA_REL = 8;          // dias para trás na lista do FNET (relatórios gerenciais)
const TENTATIVAS_AVISO = 16;   // 16 rodadas de 15 min = 4 horas esperando o valor aparecer
const MAX_PDF = 8;             // relatórios por rodada
const PAUSA_VARREDURA_MS = 50 * 60 * 1000;
const HORAS_ACOES = String(process.env.HORAS_ACOES || '12,16,20,21').split(',').map(Number).filter((n) => n >= 0).sort((a, b) => a - b);   // ações: 4 consultas por dia

const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T15:00:00Z') : new Date(Date.now() - 3 * 3600 * 1000);
const HOJE = agora.toISOString().slice(0, 10);
const HORA = process.env.HORA_TESTE ? Number(process.env.HORA_TESTE) : agora.getUTCHours();
const lerJson = (n, pad) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, n), 'utf8')); } catch (e) { return pad; } };
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const causa = (e) => (e && e.cause && (e.cause.code || e.cause.message)) ? e.message + ' (' + (e.cause.code || e.cause.message) + ')' : (e && e.message) || String(e);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
const brData = (d) => String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear();
const isoDeBR = (s) => { const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; };
const somaDias = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

if (!TESTE && !FORCAR && (HORA < 9 || HORA > 21)) { console.log('fora do horário (9h às 21h, Brasília); nada a fazer.'); process.exit(0); }

const estado0 = lerJson('agora.json', {});
const est = {
  data: HOJE,
  enviados: Array.isArray(estado0.enviados) ? estado0.enviados : [],
  provDia: estado0.provDia && estado0.provDia.data === HOJE ? estado0.provDia : { data: HOJE, itens: [] },
  avisos: Array.isArray(estado0.avisos) ? estado0.avisos : [],
  tent: estado0.tent || {},
  anunc: estado0.anunc || {},
  rel: estado0.rel || {},
  relTent: estado0.relTent || {},
  ultVarredura: estado0.ultVarredura || 0,
  acoesSlot: estado0.acoesSlot || '',
  valores: estado0.valores || {},   // último valor enviado por fundo/ação, tipo e data de pagamento (para avisar quando o valor é corrigido)
};
const inicial = JSON.stringify(est);
const diag = { gerado: new Date().toISOString(), hora: HORA };
let escreverDiag = false;
/* grava o estado já depois de cada envio: se algo falhar mais adiante, o que já foi enviado não é enviado de novo na próxima rodada */
const gravarEstado = () => { if (TESTE) return; est.data = HOJE; fs.writeFileSync(path.join(SAIDA, 'agora.json'), JSON.stringify(est)); };

async function pegar(url, { ms = 45000, tentativas = 2 } = {}) {
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { ultimo = e; await dorme(1500); }
  }
  throw new Error(causa(ultimo));
}
/* documento do FNET: ora PDF, ora texto em base64 */
async function baixarDoc(id) {
  let buf = await pegar(FNET + 'downloadDocumento?id=' + id, { ms: 60000 });
  const cru = buf.toString('latin1').trim();
  if (!cru.startsWith('%PDF') && /^"?[A-Za-z0-9+/=\s\\rn]{200,}"?$/.test(cru)) buf = Buffer.from(cru.replace(/^"|"$/g, '').replace(/\\r|\\n|\s/g, ''), 'base64');
  return buf;
}
async function listarFnet() {
  const ini = new Date(Date.parse(HOJE + 'T12:00:00Z') - JANELA_REL * 86400000), fim = new Date(Date.parse(HOJE + 'T12:00:00Z'));
  const linhas = [], L = 200;
  for (let s = 0; s < 2000; s += L) {
    const url = FNET + 'pesquisarGerenciadorDocumentosDados?d=1&s=' + s + '&l=' + L + '&o%5B0%5D%5BdataEntrega%5D=desc&dataInicial=' + encodeURIComponent(brData(ini)) + '&dataFinal=' + encodeURIComponent(brData(fim)) + '&tipoFundo=1';
    const j = JSON.parse((await pegar(url)).toString('utf8'));
    const dados = Array.isArray(j.data) ? j.data : [];
    linhas.push(...dados.filter((x) => !x.status || /^A/i.test(x.status)));
    if (dados.length < L) break;
  }
  return linhas;
}
const textoLinha = (x) => [x.categoriaDocumento, x.tipoDocumento, x.especieDocumento].filter(Boolean).join(' | ');
const ehAviso = (x) => /aviso aos cotistas/i.test(x.categoriaDocumento || '');
const ehRelatorio = (x) => /relat[oó]rio gerencial/i.test(textoLinha(x));
const chaveDoc = (x) => String(x.id) + '|' + (x.versao || 1);
const refCurta = (r) => { const t = String(r || '').trim(); const m = t.match(/^(?:\d{2}\/)?(\d{2})\/(\d{4})$/); return m ? m[1] + '/' + m[2] : t; };

async function principal() {
  const liq = lerJson('liquidez-fiis.json', null);
  const liquidos = liq && liq.fiis ? Object.keys(liq.fiis) : [];
  if (liquidos.length < 20) { diag.aviso = 'liquidez-fiis.json ausente ou vazio; rode o workflow Liquidez dos FIIs'; escreverDiag = true; console.log(diag.aviso); return; }
  const provArq = lerJson('proventos.json', {});
  const nomes = provArq.nomes || {};
  const porNome = new Map();
  for (const [cod, nome] of Object.entries(nomes)) {
    const tks = liquidos.filter((t) => t.startsWith(cod)).sort((a, b) => (/11$/.test(b) ? 1 : 0) - (/11$/.test(a) ? 1 : 0));
    if (tks.length) porNome.set(norm(nome), tks[0]);
  }
  const tkDe = (x) => porNome.get(norm(x.nomePregao)) || porNome.get(norm((x.informacoesAdicionais || '').split(';')[0])) || '';
  const universo = lerJson('universo.json', { itens: {} });
  const isinParaTicker = {};
  for (const [tk, it] of Object.entries(universo.itens || {})) if (it.isin) isinParaTicker[it.isin] = tk;
  const d1 = lerJson('d1.json', null), precos = (d1 && d1.p) || {};
  const tel = lerJson('telegram.json', {});
  const enviados = new Set([...(est.enviados || []), ...(tel.provIds || [])]);
  const semHistorico = !(est.enviados || []).length && !(tel.provIds || []).length;
  const de = somaDias(HOJE, -2);

  /* 1) lista do FNET */
  let linhas = [];
  try { linhas = await listarFnet(); } catch (e) { diag.fnet_erro = causa(e); escreverDiag = true; console.warn('aviso: FNET indisponível:', diag.fnet_erro); }
  const avisos = linhas.filter(ehAviso), relatorios = linhas.filter(ehRelatorio);
  diag.fnet = { linhas: linhas.length, avisos: avisos.length, relatorios: relatorios.length };
  if (!relatorios.length && linhas.length) { diag.fnet.tipos_amostra = [...new Set(linhas.map(textoLinha))].slice(0, 12); escreverDiag = true; }

  const avisosVistos = new Set(est.avisos);
  const corte = somaDias(HOJE, -1);
  const novosAvisos = avisos.filter((x) => isoDeBR(x.dataEntrega) >= corte && tkDe(x) && !avisosVistos.has(chaveDoc(x)));
  diag.avisos_novos = novosAvisos.map((x) => tkDe(x) + ':' + x.id);

  /* 2) valores: B3 para os fundos com aviso novo; varredura completa de hora em hora */
  const itens = new Map();
  const altVistos = new Set();
  const juntar = (arr, fonte) => { for (const x of arr) { const k = chaveProvento(x), a = chaveAlt(x); if (!itens.has(k) && !altVistos.has(a)) { itens.set(k, Object.assign({ fonte }, x)); altVistos.add(a); } } };   // o mesmo provento vindo de duas fontes (B3 e FNET) entra uma vez só
  const varrer = FORCAR || TESTE || Date.now() - est.ultVarredura >= PAUSA_VARREDURA_MS;
  if (novosAvisos.length) {
    const tks = [...new Set(novosAvisos.map(tkDe))];
    try {
      const d = {};
      const rs = await proventosFiiB3({ fiis: tks, isinParaTicker, de, diag: d, nomes: Object.assign({}, nomes) });
      juntar(rs, 'FII');
    } catch (e) { diag.b3_fii_erro = causa(e); escreverDiag = true; console.warn('aviso: B3 (fundos) falhou:', diag.b3_fii_erro); }
  }
  /* ações: só quando chega um dos horários (o mais recente já alcançado hoje ainda não consultado) */
  const slotAtual = [...HORAS_ACOES].reverse().find((h) => HORA >= h);
  const chaveSlot = slotAtual === undefined ? '' : HOJE + '|' + slotAtual;
  const fazAcoes = FORCAR || TESTE || (chaveSlot !== '' && est.acoesSlot !== chaveSlot);
  diag.acoes_nesta_rodada = fazAcoes;
  if (varrer || fazAcoes) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-'));
    try {
      for (const n of ['universo.json', 'liquidez-fiis.json', 'proventos.json']) { try { fs.copyFileSync(path.join(SAIDA, n), path.join(tmp, n)); } catch (e) { /* o que faltar a atualização trata */ } }
      await atualizarProventos(tmp, HOJE, { acoes: fazAcoes });
      const pv = JSON.parse(fs.readFileSync(path.join(tmp, 'proventos.json'), 'utf8'));
      juntar((pv.fii || []).filter((x) => liq.fiis[x.t] || ETFS_DESTAQUE.includes(x.t)), 'FII');
      if (fazAcoes) juntar(pv.acoes || [], 'AÇÃO');
      diag.varredura = { fii: (pv.fii || []).length, acoes: fazAcoes ? (pv.acoes || []).length : 'não consultadas' };
      if (!TESTE) { est.ultVarredura = Date.now(); if (fazAcoes && chaveSlot) est.acoesSlot = chaveSlot; }
      escreverDiag = true;
    } catch (e) { diag.varredura_erro = causa(e); escreverDiag = true; console.warn('aviso: varredura falhou:', diag.varredura_erro); }
    finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignora */ } }
  }

  /* 3) avisos sem valor na B3 ainda: lê o próprio aviso do FNET; se nada, espera a próxima rodada (até 4 horas) */
  const resolvidos = [];
  for (const x of novosAvisos) {
    const tk = tkDe(x), id = chaveDoc(x);
    const temNovo = [...itens.values()].some((i) => i.t === tk && !enviados.has(chaveProvento(i)));
    if (temNovo) { resolvidos.push(id); continue; }
    if ([...itens.values()].some((i) => i.t === tk)) { resolvidos.push(id); continue; }   // já enviado antes
    try {
      const doc = await baixarDoc(x.id);
      const achados = lerAvisoFii(doc.toString('utf8')).filter((a) => a.t === tk);
      if (achados.length) { juntar(achados.map((a) => Object.assign(a, { ent: HOJE, fundo: x.nomePregao || '' })), 'FII'); resolvidos.push(id); diag.lido_do_aviso = (diag.lido_do_aviso || []).concat(tk); continue; }
    } catch (e) { diag.aviso_erro = (diag.aviso_erro || []).concat(tk + ': ' + causa(e)); }
    est.tent[id] = (est.tent[id] || 0) + 1;
    if (est.tent[id] >= TENTATIVAS_AVISO) { resolvidos.push(id); diag.desistiu = (diag.desistiu || []).concat(tk); escreverDiag = true; }
    else { diag.pendentes = (diag.pendentes || []).concat(tk); }
  }

  /* 4) o que é novo e vai para o Telegram */
  let novos = [...itens.values()].filter((x) => !enviados.has(chaveProvento(x)) && !enviados.has(chaveAlt(x)));
  if (!TESTE) { if (semHistorico) novos = novos.filter((x) => x.ent === HOJE); }
  novos = novos.filter((x) => x.fonte !== 'FII' || liq.fiis[x.t] || ETFS_DESTAQUE.includes(x.t));
  /* mesmo fundo/ação, mesmo tipo e mesma data de pagamento, mas valor diferente do que já foi enviado = correção do anúncio (avisa na mensagem) */
  for (const x of novos) { const kv = [x.t, x.tipo, x.pag].join('|'); if (est.valores[kv] !== undefined && est.valores[kv] !== x.v) x.atualizado = est.valores[kv]; }
  diag.novos = novos.map((x) => x.t + ' ' + x.tipo + (x.atualizado !== undefined ? ' (corrigido)' : ''));
  if (novos.length) {
    const t = msgProventos(novos, HOJE, precos);
    if (t) await enviarTexto(t, { teste: TESTE });
    if (!TESTE) {
      for (const x of novos) { est.enviados.push(chaveProvento(x), chaveAlt(x)); est.valores[[x.t, x.tipo, x.pag].join('|')] = x.v; est.provDia.itens.push(x); if (x.fonte === 'FII' && x.cls !== 'ETF') est.anunc[x.t] = HOJE; }
      est.enviados = est.enviados.slice(-6000);
      const vk = Object.keys(est.valores); if (vk.length > 800) for (const k of vk.slice(0, vk.length - 800)) delete est.valores[k];
      gravarEstado();
    }
    escreverDiag = true;
  }
  if (!TESTE) for (const id of resolvidos) { avisosVistos.add(id); delete est.tent[id]; }
  est.avisos = [...avisosVistos].slice(-3000);

  /* 5) relatório gerencial dos FIIs com provento anunciado nos últimos 10 dias (um por fundo e mês de referência) */
  for (const tk of Object.keys(est.anunc)) if (est.anunc[tk] < somaDias(HOJE, -10)) delete est.anunc[tk];
  let enviadosPdf = 0;
  for (const tk of Object.keys(est.anunc)) {
    if (enviadosPdf >= MAX_PDF) break;
    const desde = somaDias(est.anunc[tk], -7);
    const cand = relatorios.filter((x) => tkDe(x) === tk && isoDeBR(x.dataEntrega) >= desde).sort((a, b) => (isoDeBR(b.dataEntrega) + String(b.dataEntrega).slice(11)).localeCompare(isoDeBR(a.dataEntrega) + String(a.dataEntrega).slice(11)));
    if (!cand.length) continue;
    const x = cand[0], id = chaveDoc(x), ref = refCurta(x.dataReferencia);
    if (est.rel[tk] === ref || est.rel[tk + '|' + id]) continue;
    try {
      const buf = await baixarDoc(x.id);
      if (buf.subarray(0, 4).toString() !== '%PDF') throw new Error('o relatório não veio em PDF');
      const nome = (tk + '-relatorio-gerencial' + (ref ? '-' + ref.replace('/', '-') : '') + '.pdf');
      await enviarPdf(buf, nome, '📎 ' + tk + ' — Relatório gerencial' + (ref ? ' (' + ref + ')' : '') + '\nFonte: FNET/B3 (documento do próprio fundo).', { teste: TESTE });
      if (!TESTE) { est.rel[tk] = ref || id; est.rel[tk + '|' + id] = 1; delete est.relTent[id]; }
      enviadosPdf++; escreverDiag = true;
    } catch (e) {
      est.relTent[id] = (est.relTent[id] || 0) + 1;
      diag.pdf_erro = (diag.pdf_erro || []).concat(tk + ': ' + causa(e)); escreverDiag = true;
      if (est.relTent[id] >= 3 && !TESTE) { est.rel[tk + '|' + id] = 1; delete est.relTent[id]; }
    }
  }
  diag.pdfs = enviadosPdf;
  const relKeys = Object.keys(est.rel);
  if (relKeys.length > 600) for (const k of relKeys.slice(0, relKeys.length - 600)) delete est.rel[k];
}

try { await principal(); } catch (e) { diag.erro = causa(e); escreverDiag = true; console.error('ERRO:', diag.erro); process.exitCode = 1; }
if (!TESTE) {
  est.data = HOJE;
  const novo = JSON.stringify(est);
  if (novo !== inicial) fs.writeFileSync(path.join(SAIDA, 'agora.json'), novo);
  if (escreverDiag) fs.writeFileSync(path.join(SAIDA, 'agora-diag.json'), JSON.stringify(diag, null, 1));
}
console.log('proventos agora:', JSON.stringify({ fnet: diag.fnet, avisos_novos: diag.avisos_novos, novos: diag.novos, pendentes: diag.pendentes, pdfs: diag.pdfs, erro: diag.erro, aviso: diag.aviso }));
