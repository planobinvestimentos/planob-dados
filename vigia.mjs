/* VIGIA do Plano B: confere se cada envio do dia realmente aconteceu e, se não aconteceu, te avisa no Telegram (conversa PRIVADA com o bot, nunca no canal).
   Roda no GitHub Actions (.github/workflows/vigia.yml). Quem chama é o relógio da Cloudflare, no prazo de cada envio (ex.: 11h45 para o juros das 11h).
   Não envia nada ao canal e não mexe em nenhum arquivo do repositório: só LÊ.
   Como confere:
     1) arquivos de estado em saida/ (ex.: juros.json diz se a edição das 11h saiu);
     2) execuções do GitHub Actions (rodou? deu certo? deu erro?).
   Se faltou, o aviso mostra o que não saiu, a última execução do fluxo (com link) e, se houver chave da IA e a execução tiver falhado, uma explicação curta em português
   feita pelo Claude lendo o final do log (custo de centavos, só quando há falha).
   Feriado da B3 ou "provável feriado" no diagnóstico do próprio fluxo: não é falha, não avisa.
   Variáveis: GITHUB_TOKEN e GITHUB_REPOSITORY (automáticas no Actions), TELEGRAM_BOT_TOKEN, TELEGRAM_ALERTA_CHAT_ID (seu id pessoal no Telegram), ANTHROPIC_API_KEY (opcional).
   VERIFICAR = id de uma conferência (ver CHECKS) | teste (manda um aviso de teste para o seu Telegram) | todos (as que já passaram do prazo hoje) | fimdodia (confere se o relógio da Cloudflare funcionou hoje; se não, confere tudo).
   Opcionais: TESTE=1 (mostra o aviso no log, não envia). Se achar problema, o fluxo termina em ❌ (o GitHub também manda e-mail). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = process.env.SAIDA_DIR || path.join(RAIZ, 'saida');
const TESTE = process.env.TESTE === '1';
const API_GH = process.env.GITHUB_API_URL || 'https://api.github.com';
const API_TG = process.env.TELEGRAM_API || 'https://api.telegram.org';
const IA_URL = process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const IA_MODELO = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const REPO = process.env.GITHUB_REPOSITORY || 'planobinvestimentos/planob-dados';
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const UTIL = [1, 2, 3, 4, 5], TODOS = [0, 1, 2, 3, 4, 5, 6];
/* feriados em que a B3 não abre (dia útil que não tem pregão): juros, parcial, fechamento e fluxo não são cobrados */
const FERIADOS_B3 = new Set(['2026-11-20', '2026-12-24', '2026-12-25', '2026-12-31', '2027-01-01', '2027-02-08', '2027-02-09', '2027-02-10']);
const EXPLICA_SEM_ENVIO = /feriado|sem preg[aã]o|fim de semana|nenhum evento|nada a enviar/i;

/* agora em Brasília (UTC-3) */
const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T' + (process.env.HORA_TESTE || '12') + ':' + String(process.env.MINUTO_TESTE || '0').padStart(2, '0') + ':00Z') : new Date(Date.now() - 3 * 3600 * 1000);
const HOJE = agora.toISOString().slice(0, 10);
const DOW = agora.getUTCDay();
const MIN_AGORA = agora.getUTCHours() * 60 + agora.getUTCMinutes();
const dataBR = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const hm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const minutos = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

const lerJson = (arq, padrao = null) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, arq), 'utf8')); } catch (e) { return padrao; } };
const hojeEm = (j) => j && j.data === HOJE;
const diagExplica = (arq) => { const d = lerJson(arq, null); return !!(d && d.hoje === HOJE && EXPLICA_SEM_ENVIO.test(String(d.resultado || ''))); };

/* ---------- as conferências ----------
   id, rotulo (o que aparece no aviso), fluxo (arquivo do workflow), dias, prazo (Brasília, depois do qual a falta vira alerta), b3 (não cobra em feriado da B3),
   estado() => true se saiu, explicado() => true se a falta é normal (opcional), janela (tipo "execução": a partir de que hora a execução conta) */
export const CHECKS = [
  { id: 'abertura-manha', rotulo: 'Abertura dos mercados (manhã)', fluxo: 'abertura.yml', dias: UTIL, prazo: '07:30', estado: () => hojeEm(lerJson('abertura.json')) && !!lerJson('abertura.json').manha },
  { id: 'manchetes', rotulo: 'Manchetes do dia', fluxo: 'manchetes.yml', dias: UTIL, prazo: '07:45', estado: () => (lerJson('manchetes.json') || {}).enviado === HOJE },
  { id: 'agenda', rotulo: 'Agenda (semana/do dia)', fluxo: 'agenda.yml', dias: UTIL, prazo: '08:30', estado: () => (lerJson('agenda.json') || {}).enviado === (DOW === 1 ? 'semana' : 'hoje') + ':' + HOJE, explicado: () => { const d = lerJson('agenda-diag.json'); return !!(d && d.hoje === HOJE && d.eventos === 0); } },
  { id: 'divulgacao-9', rotulo: 'Divulgação do site das 9h', fluxo: 'divulgacao.yml', dias: TODOS, prazo: '09:45', estado: () => hojeEm(lerJson('divulgacao-estado.json')) && !!lerJson('divulgacao-estado.json').slots['9'] },
  { id: 'noticias-9', rotulo: 'Noticiário corporativo das 9h (execução)', fluxo: 'noticias.yml', dias: UTIL, prazo: '09:45', execucao: '08:55' },
  { id: 'abertura-futuros', rotulo: 'Abertura: futuros BR', fluxo: 'abertura.yml', dias: UTIL, b3: true, prazo: '10:30', estado: () => hojeEm(lerJson('abertura.json')) && !!lerJson('abertura.json').futuros },
  { id: 'fluxo', rotulo: 'Fluxo de investidores (execução)', fluxo: 'fluxo.yml', dias: UTIL, b3: true, prazo: '10:50', execucao: '09:55' },
  { id: 'juros-11', rotulo: 'Juros futuros das 11h', fluxo: 'juros.yml', dias: UTIL, b3: true, prazo: '11:45', estado: () => hojeEm(lerJson('juros.json')) && !!lerJson('juros.json').slots['11'], explicado: () => diagExplica('juros-diag.json') },
  { id: 'previa-12', rotulo: 'Parcial do pregão das 12h', fluxo: 'previa.yml', dias: UTIL, b3: true, prazo: '12:45', estado: () => hojeEm(lerJson('previa.json')) && !!lerJson('previa.json').slots['12'], explicado: () => diagExplica('previa-diag.json') },
  { id: 'noticias-12', rotulo: 'Noticiário corporativo das 12h (execução)', fluxo: 'noticias.yml', dias: UTIL, prazo: '12:45', execucao: '11:55' },
  { id: 'divulgacao-13', rotulo: 'Divulgação do site das 13h', fluxo: 'divulgacao.yml', dias: TODOS, prazo: '13:45', estado: () => hojeEm(lerJson('divulgacao-estado.json')) && !!lerJson('divulgacao-estado.json').slots['13'] },
  { id: 'noticias-15', rotulo: 'Noticiário corporativo das 15h (execução)', fluxo: 'noticias.yml', dias: UTIL, prazo: '15:45', execucao: '14:55' },
  { id: 'previa-15', rotulo: 'Parcial do pregão das 15h', fluxo: 'previa.yml', dias: UTIL, b3: true, prazo: '15:45', estado: () => hojeEm(lerJson('previa.json')) && !!lerJson('previa.json').slots['15'], explicado: () => diagExplica('previa-diag.json') },
  { id: 'juros-18', rotulo: 'Juros futuros das 18h', fluxo: 'juros.yml', dias: UTIL, b3: true, prazo: '18:45', estado: () => hojeEm(lerJson('juros.json')) && !!lerJson('juros.json').slots['18'], explicado: () => diagExplica('juros-diag.json') },
  { id: 'fechamento-rapido', rotulo: 'Fechamento rápido das 18h20 (o oficial das 20h cobre se faltar)', fluxo: 'fechamento-rapido.yml', dias: UTIL, b3: true, prazo: '19:15', estado: () => hojeEm(lerJson('previa.json')) && !!lerJson('previa.json').slots.fech, explicado: () => diagExplica('previa-diag.json') },
  { id: 'divulgacao-19', rotulo: 'Divulgação do site das 19h', fluxo: 'divulgacao.yml', dias: TODOS, prazo: '19:45', estado: () => hojeEm(lerJson('divulgacao-estado.json')) && !!lerJson('divulgacao-estado.json').slots['19'] },
  { id: 'dolar-cripto', rotulo: 'Dólar e criptomoedas das 20h', fluxo: 'telegram.yml', dias: TODOS, prazo: '20:50', estado: () => hojeEm(lerJson('telegram.json')) && !!(lerJson('telegram.json').enviado || {}).merc },
  { id: 'resumo-dia', rotulo: 'Resumo do dia (proventos) das 22h', fluxo: 'telegram.yml', dias: UTIL, prazo: '22:50', estado: () => hojeEm(lerJson('telegram.json')) && !!(lerJson('telegram.json').enviado || {}).resumo },
  { id: 'fechamento-dia', rotulo: 'Fechamento do dia (altas e baixas, rápido ou oficial)', fluxo: 'telegram.yml', dias: UTIL, b3: true, prazo: '23:50', estado: () => (hojeEm(lerJson('telegram.json')) && !!(lerJson('telegram.json').enviado || {}).fech) || (hojeEm(lerJson('previa.json')) && !!lerJson('previa.json').slots.fech) },
];

/* ---------- GitHub ---------- */
async function gh(caminho, texto = false) {
  const r = await fetch(API_GH + caminho, { headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'planob-vigia' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('GitHub HTTP ' + r.status + ' em ' + caminho.split('?')[0]);
  return texto ? r.text() : r.json();
}
const brt = (iso) => new Date(new Date(iso).getTime() - 3 * 3600 * 1000);
const emBrt = (iso) => { const d = brt(iso); return { data: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; };

/* execuções de hoje de um fluxo, da mais nova para a mais velha */
const cacheRuns = {};
async function execucoesHoje(fluxo) {
  if (cacheRuns[fluxo]) return cacheRuns[fluxo];
  try {
    const desde = new Date(Date.parse(HOJE + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    const j = await gh('/repos/' + REPO + '/actions/workflows/' + fluxo + '/runs?per_page=30&created=%3E%3D' + desde);
    cacheRuns[fluxo] = (j.workflow_runs || []).map((r) => ({ id: r.id, status: r.status, conclusao: r.conclusion, evento: r.event, url: r.html_url, criada: emBrt(r.created_at) })).filter((r) => r.criada.data === HOJE);
  } catch (e) { console.warn('aviso: não consegui ler as execuções de', fluxo + ':', e.message); cacheRuns[fluxo] = null; }
  return cacheRuns[fluxo];
}
const resumoExec = (r) => (r.status !== 'completed' ? 'ainda em andamento (' + r.status + ')' : r.conclusao === 'success' ? 'terminou sem erro' : r.conclusao === 'failure' ? 'FALHOU' : String(r.conclusao)) + ' · iniciou às ' + hm(r.criada.min) + ' (' + (r.evento === 'workflow_dispatch' ? 'relógio/manual' : 'horário do GitHub') + ') · ' + r.url;

/* explicação em português simples, feita pelo Claude, só quando a execução falhou */
async function explicarFalha(run) {
  if (!process.env.ANTHROPIC_API_KEY) return '';
  try {
    const jobs = (await gh('/repos/' + REPO + '/actions/runs/' + run.id + '/jobs')).jobs || [];
    const ruim = jobs.find((j) => j.conclusion === 'failure') || jobs[0];
    if (!ruim) return '';
    const log = (await gh('/repos/' + REPO + '/actions/jobs/' + ruim.id + '/logs', true)).replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /gm, '').slice(-5000);
    const r = await fetch(IA_URL, {
      method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, signal: AbortSignal.timeout(40000),
      body: JSON.stringify({ model: IA_MODELO, max_tokens: 300, messages: [{ role: 'user', content: 'Este é o final do log de uma rotina automática (GitHub Actions) de um bot de investimentos no Telegram que falhou. Em no máximo 3 frases curtas, em português simples (o dono não é programador), diga o provável motivo e o que fazer (ex.: esperar a próxima tentativa, rodar de novo, ou me chamar). Não invente: se o log não deixar claro, diga isso.\n\n' + log }] }),
    });
    const j = await r.json();
    return ((j.content || []).find((c) => c.type === 'text') || {}).text || '';
  } catch (e) { console.warn('aviso: sem explicação da IA:', e.message); return ''; }
}

/* ---------- conferir uma ----------
   devolve null (tudo certo / não se aplica) ou { check, texto } */
async function conferir(c) {
  if (!c.dias.includes(DOW)) return null;
  if (c.b3 && FERIADOS_B3.has(HOJE)) return null;
  if (MIN_AGORA < minutos(c.prazo) && !process.env.VERIFICAR_JA) return null;
  const runs = await execucoesHoje(c.fluxo);
  let faltou;
  if (c.execucao) {
    const ok = runs && runs.some((r) => r.status === 'completed' && r.conclusao === 'success' && r.criada.min >= minutos(c.execucao));
    if (runs === null) return null;   // GitHub não respondeu: não dá para afirmar nada
    faltou = !ok;
  } else {
    if (c.estado()) return null;
    if (c.explicado && c.explicado()) return null;
    faltou = true;
  }
  if (!faltou) return null;
  const ultima = runs && runs.length ? runs[0] : null;
  let texto = '• ' + c.rotulo + (c.execucao ? ': não houve execução bem-sucedida desde as ' + c.execucao : ': não saiu até as ' + c.prazo) + '.\n  Última execução do fluxo hoje: ' + (ultima ? resumoExec(ultima) : runs === null ? 'não consegui consultar o GitHub' : 'NENHUMA (o GitHub nem iniciou o fluxo)');
  if (ultima && ultima.status === 'completed' && ultima.conclusao === 'failure') { const e = await explicarFalha(ultima); if (e) texto += '\n  Explicação (IA): ' + e.trim().replace(/\n+/g, ' '); }
  return { check: c, texto };
}

/* ---------- aviso ---------- */
async function avisar(titulo, itens) {
  const msg = ['⚠️ ' + titulo + ' · ' + DIAS[DOW] + ' ' + dataBR(HOJE) + ' ' + hm(MIN_AGORA), ...itens.map((i) => i.texto), 'Os horários de reserva do GitHub podem ainda cobrir parte disso. Veja: https://github.com/' + REPO + '/actions'].join('\n\n');
  console.log(msg);
  if (TESTE) return;
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_ALERTA_CHAT_ID;
  if (!token || !chat) { console.error('ERRO: faltam os segredos TELEGRAM_BOT_TOKEN e/ou TELEGRAM_ALERTA_CHAT_ID; o aviso ficou só neste log.'); return; }
  const r = await fetch(API_TG + '/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: msg.slice(0, 3900), disable_web_page_preview: true }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram recusou o aviso: ' + (j.description || 'HTTP ' + r.status));
  console.log('aviso enviado ao seu Telegram.');
}

/* ---------- principal ---------- */
if (process.argv[1] && process.argv[1].endsWith('vigia.mjs')) {
  const V = String(process.env.VERIFICAR || 'todos').trim();
  try {
    let lista;
    if (V === 'teste') {
      /* só para conferir que o aviso chega no seu Telegram privado */
      await avisar('TESTE DO VIGIA (está tudo certo se você leu isto)', [{ texto: '• Este é só um teste: os avisos de envios que faltarem vão chegar aqui, nesta conversa.' }]);
    } else if (V === 'fimdodia') {
      /* o relógio da Cloudflare mandou alguma conferência hoje? Se não, ele não está funcionando: avisa e confere tudo. */
      const runs = await execucoesHoje('vigia.yml');
      const relogio = runs ? runs.filter((r) => r.evento === 'workflow_dispatch' && r.criada.min < MIN_AGORA - 1).length : -1;
      lista = [];
      if (relogio === 0 && DOW >= 1 && DOW <= 5) lista.push({ texto: '• O relógio da Cloudflare não acionou nenhuma conferência hoje. Ele pode estar parado (token do GitHub vencido?). Os envios seguiram só pelos horários do GitHub, que atrasam.' });
      process.env.VERIFICAR_JA = '1';
      for (const c of CHECKS) if (relogio === 0 || relogio === -1) { const r = await conferir(c); if (r) lista.push(r); }
      if (lista.length) { await avisar('FIM DO DIA: conferência', lista); process.exitCode = 1; } else console.log('fim do dia: tudo certo.');
    } else {
      const alvo = V === 'todos' ? CHECKS : CHECKS.filter((c) => c.id === V);
      if (!alvo.length) throw new Error('conferência desconhecida: ' + V);
      lista = [];
      for (const c of alvo) { const r = await conferir(c); if (r) lista.push(r); }
      if (lista.length) { await avisar('ALERTA: o que não saiu', lista); process.exitCode = 1; } else console.log('vigia (' + V + '): tudo certo ou ainda dentro do prazo.');
    }
  } catch (e) { console.error('ERRO:', e.message); process.exitCode = 1; }
}
