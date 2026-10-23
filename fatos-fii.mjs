/* Matérias do site sobre os FIIs MAIORES (top 50 por patrimônio líquido) e, fora do top 50, sobre grandes compras e vendas dos FIIs líquidos.
   Fonte: "Fato Relevante" publicado no FNET (B3/CVM). A IA (Claude Haiku) lê o documento e classifica: compra, venda, emissão de cotas,
   gestão/estrutura (troca de gestor, fusão etc.) e imóveis/locatários. Todo número da matéria precisa existir no documento (trava de segurança).
   - Top 50: aceita os 5 tipos acima e "comunicado" (formador de mercado, calendário, decisões etc.); compra e venda precisam de valor acima de VALOR_MIN_TOP (padrão R$ 1 milhão).
   - Demais FIIs líquidos: só compra e venda acima de VALOR_MIN (padrão R$ 10 milhões; o noticias.yml usa R$ 3 milhões).
   O top 50 vem de saida/fii-info.json (campo pl, patrimônio líquido, atualizado pelo workflow Liquidez dos FIIs). Enquanto o campo não existir,
   o top 50 é o dos 50 FIIs de maior volume negociado por dia.
   Roda no GitHub Actions junto do noticiário (9h, 12h e 15h):  node fatos-fii.mjs
   Precisa de: saida/liquidez-fiis.json (workflow Liquidez dos FIIs), saida/proventos.json (traz os nomes dos fundos) e ANTHROPIC_API_KEY.
   Opcionais: TOP_FIIS (padrão 50), VALOR_MIN_TOP, VALOR_MIN, JANELA_DIAS (padrão 3), FNET_URL, ANTHROPIC_URL, ANTHROPIC_MODEL. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lerMaterias, gravarMaterias } from './materias-arquivo.mjs';
import { criarGasto } from './gasto-ia.mjs';
import { enviarTexto, RODAPE } from './proventos-msg.mjs';

const SAIDA = process.env.SAIDA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const GASTO = criarGasto(SAIDA, process.env.TETO_IA_USD);   // teto mensal de IA das matérias (padrão US$ 5), compartilhado com noticias.mjs
const FNET = process.env.FNET_URL || 'https://fnet.bmfbovespa.com.br/fnet/publico/';
const IA_URL = process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const IA_MODELO = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const IA_CHAVE = process.env.ANTHROPIC_API_KEY || '';
const VALOR_MIN = Number(process.env.VALOR_MIN) || 10000000;
const VALOR_MIN_TOP = Number(process.env.VALOR_MIN_TOP) || 1000000;
const TOP_N = Number(process.env.TOP_FIIS) || 50;
const VERSAO = 3;   // mudou o critério: na primeira rodada reanalisa os fatos dos últimos dias (matérias já publicadas não duplicam)
const ASSUNTO = { compra: 'Aquisição', venda: 'Venda', emissao: 'Emissão de cotas', gestao: 'Gestão e estrutura do fundo', locatario: 'Imóveis e locatários', comunicado: 'Comunicado ao cotista' };
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
  if (GASTO.estourou()) throw new Error('teto mensal de IA das matérias atingido (US$ ' + GASTO.teto + ')');
  const r = await fetch(IA_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': IA_CHAVE, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: IA_MODELO, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(90000) }).catch((e) => { throw new Error('chamada à API da Anthropic falhou: ' + causa(e)); });
  const j = await r.json().catch(() => ({}));
  if (j && j.usage) GASTO.somar(IA_MODELO, j.usage);
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
    '\n\nTarefa: classifique o documento em UM destes tipos: "compra" (aquisição de imóveis, participações, cotas ou outros ativos pelo fundo), "venda" (alienação de ativos pelo fundo), "emissao" (nova emissão ou oferta de cotas do fundo), "gestao" (troca de gestor ou administrador, incorporação, fusão ou mudança relevante na estrutura ou na política do fundo), "locatario" (rescisão, renovação, inadimplência ou vacância relevante de imóveis ou de locatários), "comunicado" (qualquer outra informação nova e relevante para o cotista: contratação ou troca de formador de mercado, mudança de calendário ou de política de rendimentos, decisões de assembleia, aprovação de oferta, mudança de taxas, litígio, etc.) ou "outro" (somente formalidade sem novidade: retificação sem mudança de conteúdo, repetição de comunicado já feito, ata, relatório periódico). Responda apenas com JSON: {"tipo":"compra|venda|emissao|gestao|locatario|comunicado|outro","valor_total_reais":número ou null,"titulo":"até 90 caracteres, factual","resumo":"até 180 caracteres","paragrafos":["3 a 5 parágrafos curtos"]}. ' +
    'Use "outro" apenas para formalidades sem novidade (e, nesse caso, deixe titulo/resumo/paragrafos vazios). Regras da matéria: use SOMENTE o que está no documento; não invente; não dê opinião, recomendação ou previsão; copie valores, percentuais, áreas e datas EXATAMENTE como estão no texto, sem converter nem arredondar; não cite outros fundos ou empresas além das do documento; no título e no texto diga EXATAMENTE o instrumento negociado (imóvel, fração de imóvel, participação em shopping, CRI, cotas de outro fundo etc.): se o fundo comprou um CRI ou cotas, não escreva que comprou o imóvel; numa emissão de cotas, informe só o que o texto traz (valor, preço da cota, datas); explique em uma frase simples termos técnicos (alienação, cap rate, fato relevante). "valor_total_reais" é o valor total da operação (compra, venda ou emissão) em reais, como número (ex.: 125000000), ou null se o texto não informar.';
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
  /* o nome do fundo no FNET nem sempre é igual ao da B3: compara também sem "FII/FDO/IMOB..." e por início do nome */
  const miolo = (s) => norm(s).replace(/[^A-Z0-9 ]/g, ' ').split(' ').filter((p) => p && !['FII', 'FDO', 'FUNDO', 'INV', 'INVEST', 'INVESTIMENTO', 'INVESTIMENTOS', 'IMOB', 'IMOBILIARIO', 'IMOBILIARIOS', 'DE', 'DO', 'DA'].includes(p)).join(' ');
  const porMiolo = new Map([...porNome].map(([n, t]) => [miolo(n), t]));
  const tkAprox = (nome) => {
    const m = miolo(nome);
    if (!m || m.length < 4) return '';
    if (porMiolo.has(m)) return porMiolo.get(m);
    const cand = [...porMiolo].filter(([k]) => k.length >= 4 && (k.startsWith(m + ' ') || m.startsWith(k + ' ')));
    return cand.length === 1 ? cand[0][1] : '';
  };
  const tkDe = (x) => porNome.get(norm(x.nomePregao)) || porNome.get(norm((x.informacoesAdicionais || '').split(';')[0])) || tkAprox(x.nomePregao) || tkAprox((x.informacoesAdicionais || '').split(';')[0]) || '';
  /* top N: maiores por patrimônio líquido (fii-info.json); sem esse dado ainda, os de maior volume negociado */
  const info = (lerJson('fii-info.json', {}) || {}).itens || {};
  let ranking = fiis.filter((t) => info[t] && info[t].pl > 0).sort((a, b) => info[b].pl - info[a].pl), criterio = 'patrimonio_liquido';
  if (ranking.length < TOP_N) { ranking = fiis.slice().sort((a, b) => (liq.fiis[b] || 0) - (liq.fiis[a] || 0)); criterio = 'volume_negociado'; }
  const top = new Set(ranking.slice(0, TOP_N));
  diag.top = { criterio, tamanho: top.size, fundos: [...top] };
  const estado = lerJson('fatos-fii.json', { vistos: [] });
  const vistos = new Set(estado.v === VERSAO ? (estado.vistos || []) : []);
  const dl = {}; diag.lista = dl;
  const fatos = await listarFatos(dl);
  const meus = fatos.filter((x) => tkDe(x));
  const semTk = fatos.filter((x) => !tkDe(x)).map((x) => limpa(x.nomePregao || x.descricaoFundo)).filter(Boolean);
  if (semTk.length) diag.fatos_sem_ticker = [...new Set(semTk)].slice(0, 30);
  dl.de_fiis_liquidos = meus.length;
  const novos = meus.filter((x) => !vistos.has(String(x.id) + '|' + (x.versao || 1))).slice(0, MAX_POR_RODADA);
  const arq = lerMaterias(SAIDA);   // se o arquivo existir e estiver ilegível, para aqui (não apaga matérias)
  const existentes = new Set((arq.materias || []).map((m) => m.chave));
  const novas = [];
  diag.analisados = 0; diag.sem_texto = 0; diag.fora_do_escopo = 0; diag.abaixo_do_minimo = 0; diag.reprovadas = [];
  for (const x of novos) {
    const chaveDoc = String(x.id) + '|' + (x.versao || 1);
    const tk = tkDe(x);
    try {
      const texto = await textoDoDocumento(x.id);
      if (limpa(texto).length < 150) { diag.sem_texto++; vistos.add(chaveDoc); continue; }
      const j = await analisar(x, tk, texto);
      diag.analisados++;
      vistos.add(chaveDoc);
      const grande = top.has(tk);
      const aceitos = grande ? ['compra', 'venda', 'emissao', 'gestao', 'locatario', 'comunicado'] : ['compra', 'venda'];
      if (!aceitos.includes(j.tipo)) { diag.fora_do_escopo++; continue; }
      if (j.tipo === 'compra' || j.tipo === 'venda') {
        const val = Number(j.valor_total_reais);
        if (!(val >= (grande ? VALOR_MIN_TOP : VALOR_MIN))) { diag.abaixo_do_minimo++; continue; }
      }
      if (!j.titulo || !Array.isArray(j.paragrafos) || j.paragrafos.length < 2) { diag.reprovadas.push({ id: x.id, motivo: 'matéria incompleta' }); continue; }
      const t = numerosOk(j, texto, dataISOdeBR(x.dataEntrega).slice(0, 4));
      if (!t.ok) { diag.reprovadas.push({ id: x.id, fundo: tk, numeros_fora_do_documento: t.sobra.slice(0, 8) }); continue; }
      const chave = 'fii-fato|' + chaveDoc;
      if (existentes.has(chave)) continue;
      const data = dataISOdeBR(x.dataEntrega);
      novas.push({ slug: (data + '-' + tk + '-' + j.tipo + '-' + x.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-'), chave, data, titulo: limpa(j.titulo).slice(0, 140), resumo: limpa(j.resumo).slice(0, 220), paragrafos: j.paragrafos.map(limpa).filter(Boolean).slice(0, 6), tipo: 'fato-relevante', empresa: limpa(x.descricaoFundo), tickers: [tk], setor: 'fii', top50: grande, fonte: { categoria: 'Fato Relevante (FNET/B3)', assunto: ASSUNTO[j.tipo] || 'Fato relevante', link: FNET + 'exibirDocumento?id=' + x.id + '&cvm=true' }, criada: new Date().toISOString() });
    } catch (e) { diag.reprovadas.push({ id: x.id, erro: e.message }); /* não marca como visto: tenta de novo na próxima rodada */ }
  }
  diag.materias_novas = novas.length;
  if (novas.length) {
    gravarMaterias(SAIDA, novas, arq.materias || []);
  }
  /* Telegram: cada fato novo (dos 50 maiores FIIs: qualquer assunto relevante; dos demais: grandes compras e vendas) vai na hora para o canal, uma vez só */
  const tg = new Set(estado.tg || []);
  diag.telegram = { enviados: 0, erros: [] };
  for (const m of novas) {
    if (tg.has(m.chave)) continue;
    const corpo = '🏢 FATO RELEVANTE · ' + m.tickers[0] + '\n' + m.empresa + '\n\n' + m.titulo + '\n\n' + (m.paragrafos || []).slice(0, 3).join('\n\n') + '\n\n📄 Documento oficial (FNET/B3): ' + m.fonte.link + '\n\n' + RODAPE;
    try { await enviarTexto(corpo, { teste: process.env.TESTE === '1' }); tg.add(m.chave); diag.telegram.enviados++; }
    catch (e) { diag.telegram.erros.push(m.tickers[0] + ': ' + e.message); }
  }
  fs.writeFileSync(path.join(SAIDA, 'fatos-fii.json'), JSON.stringify({ v: VERSAO, vistos: [...vistos].slice(-3000), tg: [...tg].slice(-500) }));
}

try { await principal(); } catch (e) { diag.erro = causa(e); console.error('ERRO:', diag.erro); process.exitCode = 1; }
fs.writeFileSync(path.join(SAIDA, 'fatos-fii-diag.json'), JSON.stringify(diag, null, 1));
console.log('fatos FII:', JSON.stringify({ aviso: diag.aviso, erro: diag.erro, lista: diag.lista, novas: diag.materias_novas }));
