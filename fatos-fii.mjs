/* Matérias do site sobre GRANDES COMPRAS E VENDAS de imóveis/ativos dos FIIs com liquidez acima de R$ 1 milhão por dia.
   Fonte: "Fato Relevante" publicado no FNET (B3/CVM). A IA (Claude Haiku) lê o documento e só gera matéria se houver
   compra ou venda com valor informado acima do mínimo; todo número da matéria precisa existir no documento (trava de segurança).
   Roda no GitHub Actions junto do noticiário (12h e 15h):  node fatos-fii.mjs
   Precisa de: saida/liquidez-fiis.json (workflow Liquidez dos FIIs), saida/proventos.json (traz os nomes dos fundos) e ANTHROPIC_API_KEY.
   Opcionais: VALOR_MIN (padrão 10000000 = R$ 10 milhões), JANELA_DIAS (padrão 3), FNET_URL, ANTHROPIC_URL, ANTHROPIC_MODEL. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lerMaterias, gravarMaterias } from './materias-arquivo.mjs';

const SAIDA = process.env.SAIDA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const FNET = process.env.FNET_URL || 'https://fnet.bmfbovespa.com.br/fnet/publico/';
const IA_URL = process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const IA_MODELO = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const IA_CHAVE = process.env.ANTHROPIC_API_KEY || '';
const VALOR_MIN = Number(process.env.VALOR_MIN) || 10000000;
const JANELA = Number(process.env.JANELA_DIAS) || 3;
const MAX_POR_RODADA = Number(process.env.MAX_DOCS) || 15;
const UA = { 'User-Agent': 'PlanoB-Investimentos-dados/1.0 (uso educacional)', Accept: 'application/json, text/plain, */*' };
const diag = { gerado: new Date().toISOString(), valor_min: VALOR_MIN };
const lerJson = (n, pad) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, n), 'utf8')); } catch (e) { return pad; } };
const causa = (e) => (e && e.cause && (e.cause.code || e.cause.message)) ? e.message + ' (' + (e.cause.code || e.cause.message) + ')' : (e && e.message) || String(e);
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
const brData = (d) => String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear();
const dataISOdeBR = (s) => { const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; };

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

async function listarFatos(diagLista) {
  const hoje = new Date(Date.now() - 3 * 3600 * 1000);
  const ini = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - JANELA));
  const fim = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));
  const linhas = [], categorias = {};
  const L = 200;
  for (let s = 0; s < 1600; s += L) {
    const url = FNET + 'pesquisarGerenciadorDocumentosDados?d=1&s=' + s + '&l=' + L + '&o%5B0%5D%5BdataEntrega%5D=desc&dataInicial=' + encodeURIComponent(brData(ini)) + '&dataFinal=' + encodeURIComponent(brData(fim)) + '&tipoFundo=1';
    const j = JSON.parse((await pegar(url)).toString('utf8'));
    const dados = Array.isArray(j.data) ? j.data : [];
    for (const x of dados) { categorias[x.categoriaDocumento] = (categorias[x.categoriaDocumento] || 0) + 1; if (/fato relevante/i.test(x.categoriaDocumento || '')) linhas.push(x); }
    if (dados.length < L) break;
  }
  diagLista.linhas_vistas = Object.values(categorias).reduce((a, b) => a + b, 0);
  diagLista.categorias = Object.fromEntries(Object.entries(categorias).sort((a, b) => b[1] - a[1]).slice(0, 8));
  diagLista.fatos_relevantes = linhas.length;
  return linhas;
}

async function textoDoDocumento(id) {
  let buf = await pegar(FNET + 'downloadDocumento?id=' + id, { ms: 60000 });
  const cru = buf.toString('latin1').trim();
  if (!cru.startsWith('%PDF') && /^"?[A-Za-z0-9+/=\s\\rn]{200,}"?$/.test(cru)) buf = Buffer.from(cru.replace(/^"|"$/g, '').replace(/\\r|\\n|\s/g, ''), 'base64');
  if (buf.subarray(0, 4).toString() === '%PDF') {
    const tmp = path.join(os.tmpdir(), 'fii-' + id + '-' + Date.now() + '.pdf');
    fs.writeFileSync(tmp, buf);
    try { return execFileSync('pdftotext', ['-l', '10', '-layout', tmp, '-'], { encoding: 'utf8', timeout: 30000, maxBuffer: 8e6 }); }
    finally { try { fs.unlinkSync(tmp); } catch (e) { /* ignora */ } }
  }
  const t = buf.toString('utf8');
  if (/<html|<body|<p[ >]/i.test(t)) return t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  if (/<\?xml|<[a-z]+:?[A-Za-z]*[ >]/.test(t)) return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  throw new Error('formato de documento não suportado');
}

async function chamarIA(prompt, maxTokens = 3000) {
  const r = await fetch(IA_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': IA_CHAVE, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: IA_MODELO, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(90000) }).catch((e) => { throw new Error('chamada à API da Anthropic falhou: ' + causa(e)); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('IA: HTTP ' + r.status + ' ' + (j.error && j.error.message || ''));
  const t = (Array.isArray(j.content) ? j.content : []).filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n').trim();
  if (!t) throw new Error('IA respondeu sem texto');
  return t;
}

const canon = (s) => String(s).replace(/\D/g, '').replace(/^0+/, '').replace(/0+$/, '');
const numerosDe = (txt) => new Set((String(txt).match(/\d[\d.,]*/g) || []).map(canon).filter(Boolean));
function numerosOk(m, fonte, ano) {
  const f = numerosDe(fonte), u = numerosDe([m.titulo, m.resumo, ...(m.paragrafos || [])].join(' '));
  const sobra = [...u].filter((x) => !f.has(x) && x !== canon(ano));
  return { ok: sobra.length === 0, sobra };
}
const limpa = (t) => String(t || '').replace(/\s+/g, ' ').trim();

async function analisar(x, tk, texto) {
  const prompt = 'Você é redator do site Plano B Investimentos e escreve matérias curtas sobre comunicados de fundos imobiliários (FIIs) para investidores iniciantes.\nFundo: ' + limpa(x.descricaoFundo) + ' (' + tk + ')\nData de entrega: ' + limpa(x.dataEntrega) + '\n\nTexto do documento (Fato Relevante):\n' + limpa(texto).slice(0, 30000) +
    '\n\nTarefa: descubra se o documento anuncia COMPRA (aquisição) ou VENDA (alienação) de imóveis, participações, cotas ou outros ativos pelo fundo, com valor total informado no texto. Responda apenas com JSON: {"tipo":"compra|venda|outro","valor_total_reais":número ou null,"titulo":"até 90 caracteres, factual","resumo":"até 180 caracteres","paragrafos":["3 a 5 parágrafos curtos"]}. ' +
    'Use "outro" para qualquer assunto diferente (emissão de cotas, troca de gestor, assembleia, distribuição de rendimentos, vacância etc.) e, nesse caso, deixe titulo/resumo/paragrafos vazios. Regras da matéria: use SOMENTE o que está no documento; não invente; não dê opinião, recomendação ou previsão; copie valores, percentuais, áreas e datas EXATAMENTE como estão no texto, sem converter nem arredondar; não cite outros fundos ou empresas além das do documento; no título e no texto diga EXATAMENTE o instrumento negociado (imóvel, fração de imóvel, participação em shopping, CRI, cotas de outro fundo etc.): se o fundo comprou um CRI ou cotas, não escreva que comprou o imóvel; explique em uma frase simples termos técnicos (alienação, cap rate, fato relevante). "valor_total_reais" é o valor total da operação em reais, como número (ex.: 125000000), ou null se o texto não informar.';
  const bruto = await chamarIA(prompt);
  const m = bruto.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('resposta da IA sem JSON');
  return JSON.parse(m[0]);
}

async function principal() {
  const liq = lerJson('liquidez-fiis.json', null);
  const prov = lerJson('proventos.json', {});
  const fiis = liq && liq.fiis ? Object.keys(liq.fiis) : [];
  if (fiis.length < 20) { diag.aviso = 'liquidez-fiis.json ausente; rode o workflow Liquidez dos FIIs'; return; }
  if (!IA_CHAVE) { diag.aviso = 'sem ANTHROPIC_API_KEY: nada feito (as compras e vendas dependem da IA)'; return; }
  const nomes = prov.nomes || {};
  if (!Object.keys(nomes).length) { diag.aviso = 'proventos.json ainda não traz os nomes dos fundos; rode o aviso de proventos (ou o workflow de liquidez) antes'; return; }
  const porNome = new Map();
  for (const [cod, nome] of Object.entries(nomes)) {
    const tks = fiis.filter((t) => t.startsWith(cod)).sort((a, b) => (/11$/.test(b) ? 1 : 0) - (/11$/.test(a) ? 1 : 0));
    if (tks.length) porNome.set(norm(nome), tks[0]);
  }
  diag.fundos_liquidos_com_nome = porNome.size;
  const estado = lerJson('fatos-fii.json', { vistos: [] });
  const vistos = new Set(estado.vistos || []);
  const dl = {}; diag.lista = dl;
  const fatos = await listarFatos(dl);
  const meus = fatos.filter((x) => porNome.has(norm(x.nomePregao)) || porNome.has(norm((x.informacoesAdicionais || '').split(';')[0])));
  dl.de_fiis_liquidos = meus.length;
  const novos = meus.filter((x) => !vistos.has(String(x.id) + '|' + (x.versao || 1))).slice(0, MAX_POR_RODADA);
  const arq = lerMaterias(SAIDA);   // se o arquivo existir e estiver ilegível, para aqui (não apaga matérias)
  const existentes = new Set((arq.materias || []).map((m) => m.chave));
  const novas = [];
  diag.analisados = 0; diag.sem_texto = 0; diag.fora_do_escopo = 0; diag.abaixo_do_minimo = 0; diag.reprovadas = [];
  for (const x of novos) {
    const chaveDoc = String(x.id) + '|' + (x.versao || 1);
    const tk = porNome.get(norm(x.nomePregao)) || porNome.get(norm((x.informacoesAdicionais || '').split(';')[0]));
    try {
      const texto = await textoDoDocumento(x.id);
      if (limpa(texto).length < 150) { diag.sem_texto++; vistos.add(chaveDoc); continue; }
      const j = await analisar(x, tk, texto);
      diag.analisados++;
      vistos.add(chaveDoc);
      if (!['compra', 'venda'].includes(j.tipo)) { diag.fora_do_escopo++; continue; }
      const val = Number(j.valor_total_reais);
      if (!(val >= VALOR_MIN)) { diag.abaixo_do_minimo++; continue; }
      if (!j.titulo || !Array.isArray(j.paragrafos) || j.paragrafos.length < 2) { diag.reprovadas.push({ id: x.id, motivo: 'matéria incompleta' }); continue; }
      const t = numerosOk(j, texto, dataISOdeBR(x.dataEntrega).slice(0, 4));
      if (!t.ok) { diag.reprovadas.push({ id: x.id, fundo: tk, numeros_fora_do_documento: t.sobra.slice(0, 8) }); continue; }
      const chave = 'fii-fato|' + chaveDoc;
      if (existentes.has(chave)) continue;
      const data = dataISOdeBR(x.dataEntrega);
      novas.push({ slug: (data + '-' + tk + '-' + j.tipo + '-' + x.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-'), chave, data, titulo: limpa(j.titulo).slice(0, 140), resumo: limpa(j.resumo).slice(0, 220), paragrafos: j.paragrafos.map(limpa).filter(Boolean).slice(0, 6), tipo: 'fato-relevante', empresa: limpa(x.descricaoFundo), tickers: [tk], setor: 'fii', fonte: { categoria: 'Fato Relevante (FNET/B3)', assunto: j.tipo === 'compra' ? 'Aquisição' : 'Venda', link: FNET + 'exibirDocumento?id=' + x.id + '&cvm=true' }, criada: new Date().toISOString() });
    } catch (e) { diag.reprovadas.push({ id: x.id, erro: e.message }); /* não marca como visto: tenta de novo na próxima rodada */ }
  }
  diag.materias_novas = novas.length;
  if (novas.length) {
    gravarMaterias(SAIDA, novas, arq.materias || []);
  }
  fs.writeFileSync(path.join(SAIDA, 'fatos-fii.json'), JSON.stringify({ vistos: [...vistos].slice(-3000) }));
}

try { await principal(); } catch (e) { diag.erro = causa(e); console.error('ERRO:', diag.erro); process.exitCode = 1; }
fs.writeFileSync(path.join(SAIDA, 'fatos-fii-diag.json'), JSON.stringify(diag, null, 1));
console.log('fatos FII:', JSON.stringify({ aviso: diag.aviso, erro: diag.erro, lista: diag.lista, novas: diag.materias_novas }));
