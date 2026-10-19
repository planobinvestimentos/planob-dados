/* Agenda dos eventos importantes da semana (Telegram, 7h de Brasília).
   Segunda-feira: "Agenda da semana" (segunda a sexta). Com MODO=hoje: só os eventos do dia.
   Fontes (cada uma opcional; se uma falhar, as outras seguem):
     1) agenda-regras.json  → datas oficiais conferidas (Copom, FOMC) + eventos que se repetem toda semana (Boletim Focus)
     2) agenda-manual.json  → eventos que o Andrade (ou o Claude) escreve à mão (IGP-10, IPCA, resultados etc.)
     3) IBGE (calendário de divulgações)         → NÃO VALIDADO: ver saida/agenda-diag.json
     4) calendário global gratuito em JSON       → NÃO VALIDADO (eventos de alto impacto: EUA, Europa, China...)
   Variáveis (segredos): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
   Opcionais: TESTE=1 (só mostra no log), FORCAR=1, MODO=semana|hoje, DATA_TESTE=AAAA-MM-DD, ANTHROPIC_API_KEY (traduz títulos em inglês). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.join(AQUI, 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const TESTE = process.env.TESTE === '1', FORCAR = process.env.FORCAR === '1';
const API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const URL_IBGE = process.env.IBGE_CALENDARIO_URL || 'https://servicodados.ibge.gov.br/api/v3/calendario/';
const URL_GLOBAL = process.env.CALENDARIO_GLOBAL_URL || 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const IA_CHAVE = process.env.ANTHROPIC_API_KEY || '';
const IA_URL = process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const IA_MODELO = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; PlanoB-Investimentos-agenda/1.0; uso educacional)', Accept: 'application/json, */*' };

const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T10:00:00Z') : new Date(Date.now() - 3 * 3600 * 1000); // relógio de Brasília (UTC−3)
const HOJE = agora.toISOString().slice(0, 10), DOW = agora.getUTCDay();
const MODO = process.argv[2] || process.env.MODO || (DOW === 1 ? 'semana' : 'hoje');
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const somaDias = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diaSemana = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();
const dataCurta = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const lerJson = (arq, dir = AQUI) => { try { return JSON.parse(fs.readFileSync(path.join(dir, arq), 'utf8')); } catch (e) { return null; } };

const BANDEIRAS = { BR: '🇧🇷', US: '🇺🇸', EU: '🇪🇺', CN: '🇨🇳', GB: '🇬🇧', JP: '🇯🇵', CA: '🇨🇦', AU: '🇦🇺', CH: '🇨🇭', NZ: '🇳🇿', DE: '🇩🇪', AR: '🇦🇷', MX: '🇲🇽', GLOBAL: '🌐' };
const MOEDA_PAIS = { USD: 'US', EUR: 'EU', CNY: 'CN', GBP: 'GB', JPY: 'JP', CAD: 'CA', AUD: 'AU', CHF: 'CH', NZD: 'NZ' };
const PAISES_GLOBAL = new Set(['US', 'EU', 'CN', 'GB', 'JP']); // só o que mexe com o mercado brasileiro

/* ---------- tradução de títulos do calendário global (o que não casar fica em inglês, ou vai para o Haiku) ---------- */
const TRADUCOES = [
  [/non-?farm employment change/i, 'Payroll: criação de empregos'],
  [/unemployment rate/i, 'Taxa de desemprego'],
  [/unemployment claims/i, 'Pedidos de seguro-desemprego'],
  [/core cpi/i, 'Núcleo do CPI (inflação ao consumidor)'],
  [/\bcpi\b/i, 'CPI (inflação ao consumidor)'],
  [/core ppi/i, 'Núcleo do PPI (inflação ao produtor)'],
  [/\bppi\b/i, 'PPI (inflação ao produtor)'],
  [/core pce/i, 'PCE (inflação preferida do Fed)'],
  [/retail sales/i, 'Vendas no varejo'],
  [/federal funds rate|fomc statement/i, 'Decisão de juros do Fed (FOMC)'],
  [/fomc press conference/i, 'Coletiva de imprensa do Fed'],
  [/fomc meeting minutes/i, 'Ata do Fed (FOMC)'],
  [/main refinancing rate|monetary policy statement|deposit facility rate/i, 'Decisão de juros do BCE'],
  [/ecb press conference/i, 'Coletiva de imprensa do BCE'],
  [/gdp/i, 'PIB'],
  [/ism manufacturing/i, 'PMI industrial (ISM)'],
  [/ism services/i, 'PMI de serviços (ISM)'],
  [/manufacturing pmi/i, 'PMI industrial'],
  [/services pmi/i, 'PMI de serviços'],
  [/jolts/i, 'Vagas abertas (JOLTS)'],
  [/consumer confidence|consumer sentiment/i, 'Confiança do consumidor'],
  [/industrial production/i, 'Produção industrial'],
  [/trade balance/i, 'Balança comercial'],
  [/bank rate|boe/i, 'Decisão de juros do Banco da Inglaterra'],
  [/boj|policy rate/i, 'Decisão de juros do Banco do Japão'],
  [/(?:fed )?chair .*speaks/i, 'Discurso do presidente do Fed'],
  [/^(.+?) speaks$/i, (m) => 'Discurso: ' + m[1]],
];
function traduz(t) {
  for (const [re, pt] of TRADUCOES) { const m = t.match(re); if (m) return { t: typeof pt === 'function' ? pt(m) : pt, ok: true }; }
  return { t, ok: false };
}

/* ---------- fontes ---------- */
// horário de Brasília a partir de um instante UTC
const brasilia = (ms) => { const d = new Date(ms - 3 * 3600 * 1000); return { iso: d.toISOString().slice(0, 10), hora: d.toISOString().slice(11, 16) }; };

function daRegras(inicio, fim, diag) {
  const r = lerJson('agenda-regras.json'), out = [];
  if (!r) { diag.regras = 'arquivo agenda-regras.json não encontrado'; return out; }
  for (let d = inicio; d <= fim; d = somaDias(d, 1)) {
    for (const s of r.semanais || []) if (diaSemana(d) === s.dia_semana) out.push({ iso: d, hora: s.hora, pais: s.pais, titulo: s.titulo, fonte: 'regra' });
  }
  for (const e of r.datas || []) if (e.data >= inicio && e.data <= fim) out.push({ iso: e.data, hora: e.hora || '', pais: e.pais, titulo: e.titulo, fonte: 'regra' });
  diag.regras = 'ok (' + out.length + ')';
  if (r.valido_ate && fim > r.valido_ate) diag.regras_aviso = 'as datas oficiais do arquivo valem só até ' + r.valido_ate + ': atualizar agenda-regras.json';
  return out;
}
function doManual(inicio, fim, diag) {
  const m = lerJson('agenda-manual.json'), out = [];
  if (!m) { diag.manual = 'arquivo agenda-manual.json não encontrado'; return out; }
  for (const e of m.eventos || []) {
    if (!e || !e.data || !e.titulo || e.data < inicio || e.data > fim) continue;
    out.push({ iso: e.data, hora: e.hora || '', pais: (e.pais || 'BR').toUpperCase(), titulo: e.titulo, fonte: 'manual' });
  }
  diag.manual = 'ok (' + out.length + ')';
  return out;
}
const IBGE_INTERESSA = /ipca|pib|pnad|desemprego|produ[cç][aã]o industrial|varejo|servi[cç]os|inpc|ipp/i;
async function doIbge(inicio, fim, diag) {
  const out = [];
  try {
    const url = URL_IBGE + '?de=' + inicio.slice(8, 10) + '-' + inicio.slice(5, 7) + '-' + inicio.slice(0, 4) + '&ate=' + fim.slice(8, 10) + '-' + fim.slice(5, 7) + '-' + fim.slice(0, 4) + '&qtd=200';
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const lista = Array.isArray(j) ? j : (j.items || j.itens || j.calendario || []);
    diag.ibge_recebidos = lista.length;
    for (const x of lista) {
      const nome = x.titulo || x.nome_produto || x.produto || x.nome || '';
      const quando = String(x.data_divulgacao || x.data || '');
      const m = quando.match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/) || quando.match(/(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/);
      if (!nome || !m) continue;
      const iso = quando.includes('/') ? m[3] + '-' + m[2] + '-' + m[1] : m[1] + '-' + m[2] + '-' + m[3];
      if (iso < inicio || iso > fim || !IBGE_INTERESSA.test(nome)) continue;
      out.push({ iso, hora: m[4] ? m[4] + ':' + m[5] : '', pais: 'BR', titulo: nome.replace(/\s+/g, ' ').trim() + ' (IBGE)', fonte: 'ibge' });
    }
    diag.ibge = 'ok (' + out.length + ' de interesse)';
  } catch (e) { diag.ibge = 'falhou: ' + e.message; }
  return out;
}
async function doGlobal(inicio, fim, diag) {
  const out = [];
  try {
    const r = await fetch(URL_GLOBAL, { headers: UA, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const lista = await r.json();
    if (!Array.isArray(lista)) throw new Error('formato inesperado');
    diag.global_recebidos = lista.length;
    for (const x of lista) {
      const pais = MOEDA_PAIS[String(x.country || '').toUpperCase()];
      if (!pais || !PAISES_GLOBAL.has(pais) || String(x.impact || '').toLowerCase() !== 'high') continue;
      const ms = Date.parse(x.date);
      if (!Number.isFinite(ms)) continue;
      const b = brasilia(ms);
      if (b.iso < inicio || b.iso > fim) continue;
      out.push({ iso: b.iso, hora: /T00:00:00/.test(String(x.date)) && /all day/i.test(String(x.time || '')) ? '' : b.hora, pais, titulo: String(x.title || '').trim(), fonte: 'global' });
    }
    diag.global = 'ok (' + out.length + ' de alto impacto)';
  } catch (e) { diag.global = 'falhou: ' + e.message; }
  return out;
}
async function traduzComIA(titulos, diag) {
  if (!IA_CHAVE || !titulos.length) return {};
  try {
    const prompt = 'Traduza para português do Brasil, de forma curta e usando o termo que o mercado financeiro brasileiro usa, os títulos de eventos econômicos abaixo. Responda SOMENTE com um array JSON de strings, na mesma ordem e com o mesmo tamanho (' + titulos.length + ').\n' + JSON.stringify(titulos);
    const r = await fetch(IA_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': IA_CHAVE, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: IA_MODELO, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = (j.content && j.content[0] && j.content[0].text || '').replace(/^```(?:json)?|```$/g, '').trim();
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr) || arr.length !== titulos.length) throw new Error('resposta fora do formato');
    diag.traducao_ia = 'ok (' + arr.length + ')';
    return Object.fromEntries(titulos.map((t, i) => [t, String(arr[i]).slice(0, 90)]));
  } catch (e) { diag.traducao_ia = 'falhou: ' + e.message; return {}; }
}

/* ---------- montagem ---------- */
const flag = (p) => BANDEIRAS[p] || '🌐';
function linhaEvento(e) { return flag(e.pais) + ' ' + (e.hora ? e.hora + ' – ' : '') + e.titulo; }
function montar(eventos, inicio, fim, modo) {
  const porDia = {};
  for (const e of eventos) (porDia[e.iso] = porDia[e.iso] || []).push(e);
  const dias = Object.keys(porDia).sort();
  if (!dias.length) return '';
  for (const d of dias) porDia[d].sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99') || a.titulo.localeCompare(b.titulo));
  const cab = modo === 'semana'
    ? '📅 AGENDA DA SEMANA · ' + dataCurta(inicio) + ' a ' + dataCurta(fim) + '/' + fim.slice(0, 4)
    : '📅 AGENDA DE HOJE · ' + DIAS[diaSemana(inicio)] + ', ' + dataCurta(inicio) + '/' + inicio.slice(0, 4);
  const corpo = dias.map((d) => (modo === 'semana' ? '🗓 ' + DIAS[diaSemana(d)].replace(/^./, (c) => c.toUpperCase()) + ' (' + dataCurta(d) + ')\n' : '') + porDia[d].map(linhaEvento).join('\n'));
  return [cab, corpo.join('\n\n'), 'Horários de Brasília. Datas e horários podem mudar: confira nas fontes oficiais (Banco Central, IBGE, Fed, BCE).', 'Conteúdo educacional. Não é recomendação de investimento.'].join('\n\n');
}

const ASSINATURA = '\n\n📲 Participe do nosso grupo do Telegram: @planobinvestimentos';
async function enviar(corpo) {
  const texto = corpo + ASSINATURA;
  if (TESTE) { console.log('--- MENSAGEM (teste, não enviada) ---\n' + texto + '\n--- fim ---'); return; }
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('faltam os segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
  const r = await fetch(API + '/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram recusou: ' + (j.description || 'HTTP ' + r.status));
  console.log('enviado ao Telegram.');
}

/* ---------- execução ---------- */
if (process.argv[1] && process.argv[1].endsWith('agenda.mjs')) {
  const arqEstado = path.join(SAIDA, 'agenda.json');
  const est = lerJson('agenda.json', SAIDA) || {};
  const chave = MODO + ':' + HOJE;
  if (DOW === 0 || DOW === 6) { if (!FORCAR) { console.log('fim de semana: sem agenda.'); process.exit(0); } }
  if (est.enviado === chave && !FORCAR) { console.log('esta agenda (' + chave + ') já foi enviada.'); process.exit(0); }
  const diag = { gerado: new Date().toISOString(), modo: MODO, hoje: HOJE };
  let inicio = HOJE, fim = HOJE;
  if (MODO === 'semana') { inicio = somaDias(HOJE, DOW === 0 ? 1 : DOW === 6 ? 2 : 1 - DOW); fim = somaDias(inicio, 4); }
  try {
    const [ibge, glob] = await Promise.all([doIbge(inicio, fim, diag), doGlobal(inicio, fim, diag)]);
    let todos = [...daRegras(inicio, fim, diag), ...doManual(inicio, fim, diag), ...ibge, ...glob];
    // tradução: dicionário primeiro; o que sobrar em inglês vai para o Haiku (se houver chave)
    const pendentes = [];
    for (const e of todos) if (e.fonte === 'global') { const t = traduz(e.titulo); e.titulo = t.t; if (!t.ok) pendentes.push(e.titulo); }
    const ia = await traduzComIA([...new Set(pendentes)], diag);
    for (const e of todos) if (e.fonte === 'global' && ia[e.titulo]) e.titulo = ia[e.titulo];
    // remove repetidos (mesma data, país e título) e prefere a fonte mais confiável
    const ordem = { regra: 0, manual: 1, ibge: 2, global: 3 }, vistos = new Map();
    todos.sort((a, b) => ordem[a.fonte] - ordem[b.fonte]);
    for (const e of todos) { const k = e.iso + '|' + e.pais + '|' + e.titulo.toLowerCase(); if (!vistos.has(k)) vistos.set(k, e); }
    // o Fed/BCE podem vir do calendário global E das regras com títulos parecidos: fica a versão da regra
    const lista = [...vistos.values()].filter((e, _, arr) => !(e.fonte === 'global' && arr.some((o) => o.fonte === 'regra' && o.iso === e.iso && o.pais === e.pais && /fed|bce|copom/i.test(o.titulo) && /fed|bce|copom/i.test(e.titulo))));
    diag.eventos = lista.length; diag.por_fonte = lista.reduce((a, e) => (a[e.fonte] = (a[e.fonte] || 0) + 1, a), {});
    try { fs.writeFileSync(path.join(SAIDA, 'agenda-diag.json'), JSON.stringify(diag, null, 1)); } catch (e) { /* ignora */ }
    console.log('agenda:', MODO, inicio + '..' + fim, '|', JSON.stringify(diag.por_fonte), '| ibge:', diag.ibge, '| global:', diag.global);
    const msg = montar(lista.slice(0, 40), inicio, fim, MODO);
    if (!msg) { console.log('nenhum evento relevante no período; nada enviado.'); process.exit(0); }
    await enviar(msg);
    if (!TESTE) fs.writeFileSync(arqEstado, JSON.stringify({ enviado: chave }));
  } catch (e) { console.error('ERRO:', e.message); process.exitCode = 1; }
}
