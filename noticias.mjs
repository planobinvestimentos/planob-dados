/* Noticiário Corporativo do Plano B no Telegram.
   Roda no GitHub Actions (.github/workflows/noticias.yml):  node noticias.mjs
   Fonte: CVM, dados abertos "IPE" (documentos que as empresas enviam à CVM: Fatos Relevantes, Avisos aos Acionistas e
   Comunicados ao Mercado). O arquivo da CVM é atualizado uma vez por dia, então um comunicado de hoje pode só aparecer
   no dia seguinte. Roda às 12h e às 15h (seg a sex); cada documento é enviado uma única vez.
   Os tickers vêm do cadastro de valores mobiliários da CVM (FCA).
   Sem chave de IA: cada linha mostra o "assunto" informado pela empresa na CVM.
   Com ANTHROPIC_API_KEY (segredo opcional): o documento é lido e resumido em 1 a 2 frases pela IA (Claude Haiku).
   Variáveis (segredos): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ANTHROPIC_API_KEY (opcional).
   Opcionais: TESTE=1 (só mostra no log), FORCAR=1 (ignora o que já foi enviado), MAXIMO (itens por mensagem, padrão 25). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lerZip, lerCsv } from './lib.mjs';

const SAIDA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const MODO = process.argv[2] || process.env.MODO || 'manha';
const TESTE = process.env.TESTE === '1', FORCAR = process.env.FORCAR === '1';
const MAXIMO = Number(process.env.MAXIMO) || 25;
const API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const CVM = process.env.CVM_URL || 'https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/';
const IA_URL = process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const IA_MODELO = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const IA_CHAVE = process.env.ANTHROPIC_API_KEY || '';
const IA_MODELO_FORTE = process.env.ANTHROPIC_MODEL_FORTE || 'claude-opus-5-5';   // só para documentos importantes das empresas em destaque
const USAR_OPUS = process.env.USAR_OPUS === '1';                                  // modelo forte DESLIGADO por padrão (ligar com USAR_OPUS=1 no noticias.yml)
const MAX_FORTE = Number(process.env.MAX_FORTE) || 8;                              // limite de documentos no modelo forte por envio
const MAX_MATERIAS = Number(process.env.MAX_MATERIAS) || 6;                          // matérias novas por envio (site)
const SITE_URL = (process.env.SITE_URL || 'https://planobinvestimentos.com').replace(/\/+$/, '');
const MAX_PROV = Number(process.env.MAX_PROV) || 30;                                // dividendos, JCP e bonificações de qualquer empresa, por envio
const MAX_OUTROS = Number(process.env.MAX_OUTROS) || 8;                            // fatos relevantes de empresas fora da lista, só manchete
const UA = { 'User-Agent': 'PlanoB-Investimentos-noticias/1.0 (uso educacional)' };
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const lerJson = (arq, pad) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, arq), 'utf8')); } catch (e) { return pad; } };
const achar = (o, re) => { const k = Object.keys(o).find((x) => re.test(x)); return k ? o[k] : ''; };
const so = (s) => String(s || '').replace(/\D/g, '');

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T13:00:00Z') : new Date(Date.now() - 3 * 3600 * 1000); // Brasília
const HOJE = agora.toISOString().slice(0, 10), DOW = agora.getUTCDay();
const dataBR = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
const iso = (d) => d.toISOString().slice(0, 10);

const causa = (e) => String((e && e.message) || e) + (e && e.cause ? ' [' + (e.cause.code || e.cause.message || e.cause) + ']' : '');
async function baixar(url, ms = 120000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms), redirect: 'follow' }).catch((e) => { throw new Error('download do documento falhou: ' + causa(e) + ' ' + url); });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return Buffer.from(await r.arrayBuffer());
}

/* ---------- lista de acompanhamento (destaques.json, editável no GitHub) ---------- */
let DESTAQUES = {}, PRINCIPAIS = new Set(), SETORES = {};
try { const cfgD = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'destaques.json'), 'utf8')); DESTAQUES = cfgD.acoes || {}; PRINCIPAIS = new Set([...Object.keys(DESTAQUES), ...(cfgD.principais || [])]); SETORES = cfgD.setores || {}; } catch (e) { console.warn('aviso: destaques.json não encontrado; sem lista de acompanhamento.'); }
const ehDestaque = (tickers) => tickers.some((t) => DESTAQUES[t.slice(0, 4)]);
/* filtro do Plano B: só empresas com lucro e dividendos nos últimos anos (saida/elegiveis.json, feito por elegiveis.mjs),
   mais as exceções escolhidas à mão em destaques.json ("excecoes": ["PETR", ...]). Enquanto a lista não existir, vale só a lista de acompanhamento. */
let EXCECOES = new Set(), ELEGIVEIS = null;
try { EXCECOES = new Set((JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'destaques.json'), 'utf8')).excecoes || []).map((x) => String(x).toUpperCase().slice(0, 4))); } catch (e) { /* ignora */ }
try { const j = JSON.parse(fs.readFileSync(path.join(SAIDA, 'elegiveis.json'), 'utf8')); if (j && j.empresas && Object.keys(j.empresas).length >= 10) ELEGIVEIS = j; } catch (e) { /* ignora */ }
const passaFiltro = (cnpj, tickers) => tickers.some((t) => EXCECOES.has(t.slice(0, 4))) || (ELEGIVEIS ? !!(ELEGIVEIS.empresas[cnpj] || (ELEGIVEIS.excecao_setor && ELEGIVEIS.excecao_setor[cnpj])) : ehDestaque(tickers));
const ehPrincipal = (tickers) => tickers.some((t) => PRINCIPAIS.has(t.slice(0, 4)));
const setorDe = (tickers) => { for (const [s, lista] of Object.entries(SETORES)) if (tickers.some((t) => lista.includes(t.slice(0, 4)))) return s; return 'geral'; };
const PROVENTO = /dividend|jcp|juros sobre|provento|bonifica|rendimento|distribui[cç][aã]o de (lucros|resultado)/i;   // anúncios de proventos (qualquer empresa)
const IMPORTANTE = /resultado|release|balan[cç]o|fus[aã]o|incorpora|aquisi|venda de|oferta|recompra|guidance|reestrutura|recupera[cç][aã]o|insolv|dividend|jcp|juros sobre/i;

/* ---------- tickers de cada empresa (CNPJ -> códigos), vindos do FCA da CVM; renovado a cada 14 dias ---------- */
async function mapaTickers(diag) {
  const arq = path.join(SAIDA, 'cnpj-tickers.json'), atual = lerJson('cnpj-tickers.json', null);
  if (atual && atual.gerado && (Date.parse(HOJE) - Date.parse(atual.gerado)) / 86400000 < 14 && Object.keys(atual.m || {}).length > 100) return atual.m;
  const m = {};
  for (const ano of [agora.getUTCFullYear(), agora.getUTCFullYear() - 1]) {
    try {
      const zip = lerZip(await baixar(CVM + 'FCA/DADOS/fca_cia_aberta_' + ano + '.zip'));
      for (const [nome, buf] of zip) {
        if (!/valor_mobiliario/i.test(nome)) continue;
        for (const r of lerCsv(buf)) {
          const cnpj = so(achar(r, /^CNPJ/)), cods = String(achar(r, /CODIGO_NEGOCIACAO|CODIGO_DE_NEGOCIACAO/)).toUpperCase().split(/[;,\s]+/).filter((x) => /^[A-Z]{4}\d{1,2}$/.test(x));
          if (!cnpj || !cods.length) continue;
          m[cnpj] = [...new Set((m[cnpj] || []).concat(cods))];
        }
      }
      if (Object.keys(m).length > 100) break;
    } catch (e) { diag['fca_' + ano] = 'erro: ' + e.message; }
  }
  if (Object.keys(m).length > 100) { try { fs.writeFileSync(arq, JSON.stringify({ gerado: HOJE, m })); } catch (e) { /* ignora */ } return m; }
  if (atual && atual.m) return atual.m;
  throw new Error('não consegui montar o mapa de tickers (FCA da CVM)');
}

/* ---------- documentos da CVM (IPE) ---------- */
const CATEGORIAS = /fato relevante|aviso aos acionistas|comunicado ao mercado/i;
const COMUNICADO_RELEVANTE = /resultado|release|dividend|jcp|juros sobre|provento|aquisi|venda de|alienac|fus[aã]o|incorpora|oferta|recompra|aumento de capital|desdobramento|grupamento|bonifica|guidance|rating|acordo|contrato|investimento|preju[ií]zo|lucro|produ[cç][aã]o|operacional|reestrutura|recupera[cç][aã]o|insolv|falencia/i;
async function documentos(janelaDias, diag) {
  const linhas = [];
  for (const ano of [agora.getUTCFullYear(), ...(agora.getUTCMonth() === 0 ? [agora.getUTCFullYear() - 1] : [])]) {
    try {
      const zip = lerZip(await baixar(CVM + 'IPE/DADOS/ipe_cia_aberta_' + ano + '.zip'));
      for (const [nome, buf] of zip) if (/\.csv$/i.test(nome)) linhas.push(...lerCsv(buf));
    } catch (e) { diag['ipe_' + ano] = 'erro: ' + e.message; }
  }
  if (!linhas.length) throw new Error('não consegui ler o arquivo IPE da CVM');
  const desde = iso(new Date(Date.parse(HOJE + 'T12:00:00Z') - janelaDias * 86400000));
  const brutos = linhas.map((r) => ({ cat: achar(r, /^CATEGORIA/), data: String(achar(r, /^DATA_ENTREGA/)).slice(0, 10) }));
  const docs = linhas.map((r) => ({
    cnpj: so(achar(r, /^CNPJ/)), empresa: achar(r, /^NOME_COMPANHIA|^NOME_CIA/), cat: achar(r, /^CATEGORIA/), tipo: achar(r, /^TIPO$/), assunto: achar(r, /^ASSUNTO/),
    data: String(achar(r, /^DATA_ENTREGA/)).slice(0, 10), prot: achar(r, /^PROTOCOLO/), ver: achar(r, /^VERSAO/), link: achar(r, /^LINK/),
  })).filter((d) => d.data >= desde && d.data <= HOJE && CATEGORIAS.test(d.cat + ' ' + d.tipo) && (!/comunicado ao mercado/i.test(d.cat + ' ' + d.tipo) || /fato relevante|aviso aos acionistas/i.test(d.cat) || COMUNICADO_RELEVANTE.test(d.assunto)));
  const recentes = {}, d10 = iso(new Date(Date.parse(HOJE + 'T12:00:00Z') - 10 * 86400000));
  for (const x of brutos) if (x.data >= d10) recentes[x.cat] = (recentes[x.cat] || 0) + 1;
  diag.ipe = { linhas: linhas.length, janela_desde: desde, data_mais_recente: brutos.reduce((m, x) => (x.data > m ? x.data : m), ''), categorias_ultimos_10_dias: recentes, na_janela_e_categorias: docs.length, colunas: Object.keys(linhas[0] || {}) };
  return docs.sort((a, b) => (b.data + b.prot).localeCompare(a.data + a.prot));
}

/* ---------- resumo por IA (opcional) ---------- */
const CACHE_TXT = new Map();
async function textoDoDocumento(link) {
  if (CACHE_TXT.has(link)) return CACHE_TXT.get(link);
  const t = await textoDoDocumento_(link); CACHE_TXT.set(link, t); return t;
}
async function textoDoDocumento_(link) {
  const buf = await baixar(link, 60000);
  if (buf.subarray(0, 4).toString() === '%PDF') {
    const tmp = path.join(os.tmpdir(), 'doc-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.pdf');
    fs.writeFileSync(tmp, buf);
    try { return execFileSync('pdftotext', ['-l', '8', '-layout', tmp, '-'], { encoding: 'utf8', timeout: 30000, maxBuffer: 8e6 }); }
    finally { try { fs.unlinkSync(tmp); } catch (e) { /* ignora */ } }
  }
  const t = buf.toString('latin1');
  if (/<html|<body|<p[ >]/i.test(t)) return t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  throw new Error('formato de documento não suportado');
}
async function chamarIA(modelo, prompt, maxTokens) {
  const r = await fetch(IA_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': IA_CHAVE, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: modelo, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(90000) }).catch((e) => { throw new Error('chamada à API da Anthropic falhou: ' + causa(e)); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('IA (' + modelo + '): HTTP ' + r.status + ' ' + (j.error && j.error.message || ''));
  const texto = (Array.isArray(j.content) ? j.content : []).filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n').trim();
  try { diag.ia_ultima = { modelo, parada: j.stop_reason, blocos: (j.content || []).map((b) => b && b.type), usado: j.usage, texto: texto.slice(0, 300) }; } catch (e) { /* ignora */ }
  if (!texto) throw new Error('IA (' + modelo + ') respondeu sem texto (parada: ' + j.stop_reason + ', blocos: ' + (j.content || []).map((b) => b && b.type).join(',') + ')');
  return texto;
}
async function resumirIA(d, diag, forte) {
  const texto = (await textoDoDocumento(d.link)).replace(/\s+/g, ' ').trim().slice(0, forte ? 30000 : 14000);
  if (texto.length < 80) throw new Error('documento sem texto legível');
  const prompt = 'Você resume comunicados de empresas listadas na B3 para um canal de investidores.\nEmpresa: ' + d.empresa + '\nCategoria: ' + d.cat + '\nAssunto informado: ' + d.assunto + '\n\nTexto do documento:\n' + texto +
    '\n\nEscreva UM parágrafo de no máximo ' + (forte ? 65 : d.prov ? 55 : 45) + ' palavras, em português, no estilo de noticiário, começando pelo nome da empresa. Diga o que foi anunciado, com os números e datas principais que estejam no texto (valores, data-com ou data-base, ex-provento, pagamento). Use somente informações do texto: não invente, não calcule o que não estiver nele, não dê opinião nem recomendação. ' + (d.prov ? 'Foque em: tipo de provento (dividendos, JCP, bonificação), valor por ação (bruto), data de corte (data-com/data-base), data do ex-provento e data de pagamento; na bonificação, a proporção e o custo atribuído. ' : '') + 'Se o documento não trouxer nada relevante para investidores, responda exatamente: NADA';
  if (forte) {
    try { const t = await chamarIA(IA_MODELO_FORTE, prompt, 2000); diag.itens.com_ia_forte = (diag.itens.com_ia_forte || 0) + 1; return t; }
    catch (e) { diag.ia_forte_erro = e.message; /* se o modelo forte falhar, tenta o rápido */ }
  }
  return chamarIA(IA_MODELO, prompt, 1500);
}

/* ---------- matérias para o site (saida/materias.json) ---------- */
const canon = (s) => String(s).replace(/\D/g, '').replace(/^0+/, '').replace(/0+$/, '');
const numerosDe = (txt) => new Set((String(txt).match(/\d[\d.,]*/g) || []).map(canon).filter(Boolean));
/* trava de segurança: todo número da matéria precisa existir no documento original (mesmo que escrito em outra unidade) */
function numerosOk(materia, textoFonte, ano) {
  const fonte = numerosDe(textoFonte), usados = numerosDe([materia.titulo, materia.resumo, ...(materia.paragrafos || [])].join(' '));
  const sobra = [...usados].filter((x) => !fonte.has(x) && x !== canon(ano) && x.length > 0);
  return { ok: sobra.length === 0, sobra };
}
async function escreverMateria(d, diag) {
  const texto = (await textoDoDocumento(d.link)).replace(/\s+/g, ' ').trim().slice(0, 30000);
  if (texto.length < 120) throw new Error('documento sem texto legível');
  const prompt = 'Você é redator do site Plano B Investimentos e escreve matérias curtas sobre comunicados de empresas da B3 para investidores iniciantes.\nEmpresa: ' + d.empresa + ' (' + d.tickers.join(', ') + ')\nCategoria: ' + d.cat + '\nAssunto informado: ' + d.assunto + '\nData de entrega à CVM: ' + dataBR(d.data) + '\n\nTexto do documento:\n' + texto +
    '\n\nEscreva uma matéria em português do Brasil usando SOMENTE o que está no documento. Regras: não invente; não dê opinião, recomendação, preço-alvo ou previsão; não use "compre" nem "venda"; copie valores, percentuais e datas EXATAMENTE como estão no texto, sem converter unidades nem arredondar; não cite outras empresas além das do documento; se uma informação não estiver no texto, não a mencione; tom neutro e claro; quando aparecer termo técnico (data-com, JCP, bonificação, fato relevante), explique em uma frase simples.' +
    '\nResponda apenas com JSON neste formato: {"titulo":"até 90 caracteres, factual, sem sensacionalismo","resumo":"até 180 caracteres, para a prévia no Telegram","paragrafos":["3 a 5 parágrafos curtos"],"tipo":"dividendos|jcp|bonificacao|resultado|fato-relevante|outro"}. Se o documento não trouxer nada relevante para investidores, responda {"nada":true}.';
  const bruto = await chamarIA(IA_MODELO, prompt, 4000);
  const m = bruto.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('resposta da IA sem JSON');
  const j = JSON.parse(m[0]);
  if (j.nada) return null;
  if (!j.titulo || !Array.isArray(j.paragrafos) || j.paragrafos.length < 2) throw new Error('matéria incompleta');
  const t = numerosOk(j, texto, d.data.slice(0, 4));
  if (!t.ok) { diag.materias_reprovadas = (diag.materias_reprovadas || []).concat([{ prot: d.prot, empresa: d.empresa, numeros_fora_do_documento: t.sobra.slice(0, 8) }]); return null; }
  const tk = d.tickers[0];
  const slug = (d.data + '-' + tk + '-' + String(j.tipo || 'outro')).toLowerCase().replace(/[^a-z0-9-]+/g, '-') + '-' + String(d.prot).replace(/\D/g, '').slice(-5);
  return { slug, chave: d.prot + '|' + d.ver, data: d.data, titulo: cab(j.titulo).slice(0, 140), resumo: cab(j.resumo || '').slice(0, 220), paragrafos: j.paragrafos.map((p) => cab(p)).filter(Boolean).slice(0, 6), tipo: String(j.tipo || 'outro'), empresa: d.empresa, tickers: d.tickers.slice(0, 3), setor: setorDe(d.tickers), fonte: { categoria: d.cat, assunto: d.assunto, link: d.link }, criada: new Date().toISOString() };
}

/* ---------- mensagem e envio ---------- */
const cab = (txt) => txt.replace(/\s+/g, ' ').trim();
function partir(texto, max = 3900) {
  const out = []; let atual = '';
  for (const bloco of texto.split('\n\n')) {
    if ((atual + '\n\n' + bloco).length > max && atual) { out.push(atual); atual = bloco; } else atual = atual ? atual + '\n\n' + bloco : bloco;
  }
  if (atual) out.push(atual);
  return out.flatMap((p) => (p.length <= max ? [p] : p.match(new RegExp('[\\s\\S]{1,' + max + '}', 'g'))));
}
const ASSINATURA = '\n\n📲 Participe do nosso grupo do Telegram: @planobinvestimentos';
async function enviar(texto) {
  for (const corpo of partir(texto)) {
    const parte = corpo + ASSINATURA;
    if (TESTE) { console.log('--- MENSAGEM (teste, não enviada) ---\n' + parte + '\n--- fim ---'); continue; }
    const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chat) throw new Error('faltam os segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
    const r = await fetch(API + '/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: parte, disable_web_page_preview: true }), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error('Telegram recusou: ' + (j.description || 'HTTP ' + r.status));
    console.log('enviado ao Telegram.');
    await dorme(1200);
  }
}

/* ---------- execução ---------- */
const est = lerJson('noticias.json', {});
const salvar = () => { if (!TESTE) fs.writeFileSync(path.join(SAIDA, 'noticias.json'), JSON.stringify(est)); };
if (est.dia !== HOJE) est.dia = HOJE;

if (DOW === 0 || DOW === 6) { console.log('fim de semana: sem noticiário.'); process.exit(0); }
const diag = { gerado: new Date().toISOString(), modo: MODO, ia: !!IA_CHAVE };
const gravaDiag = () => { try { fs.writeFileSync(path.join(SAIDA, 'noticias-diag.json'), JSON.stringify(diag, null, 1)); } catch (e) { /* ignora */ } };
try {
  if (IA_CHAVE) { try { diag.ia_teste = 'ok: ' + (await chamarIA(IA_MODELO, 'Responda apenas: ok', 10)).slice(0, 20); } catch (e) { diag.ia_teste = 'falhou: ' + causa(e); } }
  const primeira = !Array.isArray(est.enviados);
  const enviados = new Set(est.enviados || []);
  const tickers = await mapaTickers(diag);
  const todos = await documentos(primeira ? 4 : 5, diag);
  const chave = (d) => d.prot + '|' + d.ver;
  const novos = [];
  const vistosConteudo = new Set();
  let foraFiltro = 0;
  for (const d of todos) {
    if (!FORCAR && enviados.has(chave(d))) continue;
    const dup = d.cnpj + '|' + d.cat + '|' + d.assunto + '|' + d.data;   // mesmo aviso entregue em duas versões: publica só uma
    if (vistosConteudo.has(dup)) { enviados.add(chave(d)); continue; }
    vistosConteudo.add(dup);
    const t = (tickers[d.cnpj] || []);
    if (!t.length) continue;
    if (!passaFiltro(d.cnpj, t)) { foraFiltro++; continue; }
    const dest = ehDestaque(t), prov = PROVENTO.test(d.assunto || '');
    if (!dest && !prov && !/fato relevante/i.test(d.cat)) continue;  // fora da lista: Fatos Relevantes e anúncios de proventos
    novos.push(Object.assign(d, { tickers: t, dest, prov }));
  }
  /* Fatos Relevantes primeiro; limita o tamanho da mensagem */
  novos.sort((a, b) => (b.dest - a.dest) || (/fato relevante/i.test(b.cat) - /fato relevante/i.test(a.cat)) || (b.data + b.prot).localeCompare(a.data + a.prot));
  const escolhidos = [...novos.filter((d) => d.dest && !d.prov).slice(0, MAXIMO), ...novos.filter((d) => d.prov).slice(0, MAX_PROV), ...novos.filter((d) => !d.dest && !d.prov).slice(0, MAX_OUTROS)];
  diag.itens = { novos: novos.length, enviados_agora: escolhidos.length, com_ia: 0, ia_falhas: 0, fora_do_filtro: foraFiltro };
  diag.filtro = ELEGIVEIS ? 'lista elegiveis.json (' + Object.keys(ELEGIVEIS.empresas).length + ' empresas, anos ' + ELEGIVEIS.anos.join('-') + ')' : 'lista ainda não gerada: só a lista de acompanhamento';
  if (!escolhidos.length) { console.log('sem documentos novos para o noticiário.'); gravaDiag(); est.enviados = [...enviados]; salvar(); process.exit(0); }

  const linhas = [], provs = [], outros = [];
  let usadosForte = 0, geradas = 0;
  const arqMat = lerJson('materias.json', { materias: [] });
  const matExistentes = new Set((arqMat.materias || []).map((x) => x.chave)), novasMaterias = [];
  for (const d of escolhidos) {
    const tags = d.tickers.slice(0, 2).map((t) => '#' + t).join(' ');
    let texto = '', mat = null;
    /* matéria para o site: só empresas principais, com anúncio de provento, fato relevante ou assunto de peso */
    if (IA_CHAVE && geradas < MAX_MATERIAS && ehPrincipal(d.tickers) && (d.prov || /fato relevante/i.test(d.cat) || IMPORTANTE.test(d.assunto || '')) && !matExistentes.has(chave(d))) {
      try { mat = await escreverMateria(d, diag); } catch (e) { diag.materia_erro = e.message; mat = null; }
      if (mat) { geradas++; novasMaterias.push(mat); texto = mat.resumo + '\n🔗 Matéria completa: ' + SITE_URL + '/noticias-da-bolsa/?m=' + mat.slug; }
    }
    if (!texto && IA_CHAVE && (d.dest || d.prov)) {                                                     // IA só nas empresas da lista de acompanhamento
      const forte = USAR_OPUS && usadosForte < MAX_FORTE && (/fato relevante/i.test(d.cat) || IMPORTANTE.test(d.assunto || ''));
      try {
        texto = await resumirIA(d, diag, forte);
        if (forte) usadosForte++;
        if (/^NADA\.?$/i.test(texto)) { enviados.add(chave(d)); continue; }       // sem relevância: não publica
        diag.itens.com_ia++;
      } catch (e) { diag.itens.ia_falhas++; diag.ia_erro = e.message; texto = ''; }
    }
    if (!texto) texto = d.empresa + ' · ' + (d.cat || '').replace(/\s+/g, ' ') + (d.assunto ? ': ' + cab(d.assunto) : '');
    (d.prov ? provs : d.dest ? linhas : outros).push(tags + ' - ' + texto);
    enviados.add(chave(d));
  }
  diag.itens.materias = novasMaterias.length;
  if (novasMaterias.length && !TESTE) {
    const todas = [...novasMaterias, ...(arqMat.materias || [])].sort((a, b) => (b.data + b.criada).localeCompare(a.data + a.criada)).slice(0, 300);
    fs.writeFileSync(path.join(SAIDA, 'materias.json'), JSON.stringify({ atualizado: new Date().toISOString(), materias: todas }));
  }
  gravaDiag();
  if (linhas.length || provs.length || outros.length) {
    const resumoIA = diag.itens.com_ia ? 'Resumos automáticos feitos por IA a partir dos documentos enviados à CVM; confira sempre o original.' : 'Assuntos informados pelas empresas à CVM; confira sempre o documento original.';
    const sobrou = novos.length - escolhidos.length;
    await enviar(['📰 NOTICIÁRIO CORPORATIVO – ' + DIAS[DOW] + ', ' + dataBR(HOJE) + ' · ' + (agora.getUTCHours() + (agora.getUTCMinutes() >= 30 ? 1 : 0)) + 'h', ...linhas, provs.length ? '💰 Dividendos, JCP e bonificações\n' + provs.join('\n') : '', outros.length ? '📌 Outros fatos relevantes\n' + outros.join('\n') : '', sobrou > 0 ? '+' + sobrou + ' documentos no próximo envio.' : '', 'Fonte: CVM. ' + resumoIA, 'Conteúdo educacional. Não é recomendação de investimento.'].filter(Boolean).join('\n\n'));
  }
  est.enviados = [...enviados].slice(-4000);
  salvar();
} catch (e) {
  diag.erro = e.message; gravaDiag();
  console.error('ERRO:', e.message);
  process.exitCode = 1;
}
