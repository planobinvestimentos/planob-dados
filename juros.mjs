/* JUROS FUTUROS (DI) duas vezes ao dia, às 11h e às 18h (Brasília), segunda a sexta. Roda no GitHub Actions (.github/workflows/juros.yml).
   Mostra a taxa dos contratos de DI de 1 dia (B3) com vencimento em janeiro de cada ano (jan/27 até jan/35) e a variação em pontos percentuais
   contra o fechamento anterior. É a curva que o mercado usa para "precificar" a Selic futura e as taxas dos títulos prefixados do Tesouro.
   Fonte (sem chave e sem custo): scanner de futuros do TradingView, cotação com atraso de cerca de 15 minutos. Não é a fonte oficial da B3:
   o ajuste oficial do dia só sai à noite. Se a fonte falhar, ou se não houve pregão (feriado), NADA é enviado e o motivo fica em saida/juros-diag.json.
   Cada edição (11h, 18h) sai uma única vez por dia (estado em saida/juros.json). O workflow tenta na hora cheia e na meia hora.
   Também grava a última curva em saida/juros.json (campo "curva"), para o site usar depois.
   Variáveis: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Opcionais: TESTE=1 (só mostra no log, ignora horário, não grava estado), FORCAR=1 (ignora horário e "já enviou"). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enviarTexto, num } from './proventos-msg.mjs';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = process.env.SAIDA_DIR || path.join(RAIZ, 'saida');
const TESTE = process.env.TESTE === '1';
const FORCAR = process.env.FORCAR === '1';
const TV_URL = process.env.TV_FUTUROS_URL || 'https://scanner.tradingview.com/futures/scan';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; PlanoB-Investimentos-juros/1.0; uso educacional)' };
const RODAPE = 'Conteúdo educacional. Não é recomendação de investimento.';
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const HORAS_ENVIO = String(process.env.JUROS_HORAS || '11,18').split(',').map((x) => Number(x.trim())).filter((x) => x >= 0);
const ANO_MAX = Number(process.env.JUROS_ANO_MAX) || 2035;
const MESES = { F: 'Jan', G: 'Fev', H: 'Mar', J: 'Abr', K: 'Mai', M: 'Jun', N: 'Jul', Q: 'Ago', U: 'Set', V: 'Out', X: 'Nov', Z: 'Dez' };

/* agora em Brasília (UTC-3, sem horário de verão) */
const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T14:00:00Z') : new Date(Date.now() - 3 * 3600 * 1000);
const HOJE = agora.toISOString().slice(0, 10);
const DOW = agora.getUTCDay();
const HORA = process.env.HORA_TESTE ? Number(process.env.HORA_TESTE) : agora.getUTCHours();
const MINUTO = process.env.MINUTO_TESTE ? Number(process.env.MINUTO_TESTE) : agora.getUTCMinutes();
const dataBR = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

const lerJson = (arq, padrao = null) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, arq), 'utf8')); } catch (e) { return padrao; } };
const gravar = (arq, obj) => { try { fs.mkdirSync(SAIDA, { recursive: true }); fs.writeFileSync(path.join(SAIDA, arq), JSON.stringify(obj, null, 1)); } catch (e) { console.warn('aviso: não consegui gravar', arq + ':', e.message); } };
const pp = (v) => (v > 0.0049 ? '🔺 +' : v < -0.0049 ? '🔻 −' : '▫️ ') + num(Math.abs(v)) + ' p.p.';

/* ---------- fonte: TradingView (futuros de DI1) ---------- */
async function fonteTradingView() {
  const corpo = {
    filter: [{ left: 'name', operation: 'match', right: 'DI1' }], options: { lang: 'pt' }, markets: ['futures'],
    columns: ['name', 'description', 'close', 'change_abs', 'volume', 'expiration'], sort: { sortBy: 'name', sortOrder: 'asc' }, range: [0, 120],
  };
  const r = await fetch(TV_URL, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, UA), body: JSON.stringify(corpo), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('TradingView HTTP ' + r.status);
  const j = await r.json();
  const todos = [];
  for (const it of (j && j.data) || []) {
    const [nome, , taxa, dif, vol, venc] = it.d || [];
    const m = String(nome || '').toUpperCase().match(/^DI1([FGHJKMNQUVXZ])(\d{4})$/);   // só contratos com vencimento definido (ignora DI11! e o diferencial DDI1!)
    if (!m || !(taxa > 0) || taxa > 60 || !isFinite(dif)) continue;
    todos.push({ codigo: m[0], mes: m[1], ano: Number(m[2]), taxa: Number(taxa), dif: Number(dif), vol: isFinite(vol) ? Number(vol) : null, venc: venc || null });
  }
  return todos;
}

/* vértices mostrados: contratos de janeiro (F) de cada ano, do próximo até ANO_MAX */
function vertices(todos) {
  return todos.filter((x) => x.mes === 'F' && x.ano <= ANO_MAX && x.ano >= agora.getUTCFullYear()).sort((a, b) => a.ano - b.ano);
}

/* sem pregão (feriado) ou dado velho: nenhuma variação ou nenhum volume em todos os vencimentos mostrados */
function pareceParado(todos) {
  const comVol = todos.filter((x) => x.vol != null);
  const semVolume = comVol.length >= 5 && comVol.every((x) => !(x.vol > 0));
  const semVariacao = todos.length >= 5 && todos.every((x) => Math.abs(x.dif) < 1e-9);
  return { contratos: todos.length, com_volume: comVol.length, semVolume, semVariacao, parado: semVolume || semVariacao };
}

/* ---------- mensagem ---------- */
function mensagem(v) {
  const linhas = v.map((x) => MESES[x.mes] + '/' + String(x.ano).slice(2) + ': ' + num(x.taxa) + '% · ' + pp(x.dif));
  const caiu = v.filter((x) => x.dif < -0.0049).length, subiu = v.filter((x) => x.dif > 0.0049).length;
  const media = v.reduce((s, x) => s + x.dif, 0) / v.length;
  const resumo = 'Resumo: ' + caiu + ' vencimentos com taxa em queda, ' + subiu + ' em alta (média ' + (media >= 0.0049 ? '+' : media <= -0.0049 ? '−' : '') + num(Math.abs(media)) + ' p.p.).';
  return [
    '📊 JUROS FUTUROS (DI) · ' + DIAS[DOW] + ', ' + dataBR(HOJE) + ' · ' + HORA + 'h',
    'Taxa anual dos contratos de DI na B3, vencimentos de janeiro, e variação em pontos percentuais (p.p.) contra o fechamento de ontem.',
    linhas.join('\n'),
    resumo,
    'Cotações com atraso de cerca de 15 minutos, de fonte de terceiros (TradingView).',
    RODAPE,
  ].join('\n\n');
}

/* ---------- principal ---------- */
const diag = { gerado: new Date().toISOString(), hoje: HOJE, hora: HORA };
const estado = lerJson('juros.json', {});
const slots = estado.data === HOJE && estado.slots ? Object.assign({}, estado.slots) : {};   // edições já enviadas hoje, ex.: { "11": true }
const fim = (motivo, erro = false) => { diag.resultado = motivo; console.log(erro ? 'ERRO:' : 'juros:', motivo); if (!TESTE) gravar('juros-diag.json', diag); if (erro) process.exitCode = 1; };

try {
  if (!TESTE && !FORCAR) {
    if (DOW === 0 || DOW === 6) { console.log('juros: fim de semana, a bolsa não abre.'); process.exit(0); }
    if (!HORAS_ENVIO.includes(HORA)) { console.log('juros: edições às ' + HORAS_ENVIO.join('h e ') + 'h (agora ' + HORA + 'h); nada a fazer.'); process.exit(0); }
    if (slots[HORA]) { console.log('juros: a edição das ' + HORA + 'h já foi enviada.'); process.exit(0); }
  }
  let todos = [];
  try { todos = await fonteTradingView(); diag.contratos = todos.length; }
  catch (e) { diag.tradingview = 'falhou: ' + e.message; console.warn('aviso TradingView:', e.message); }
  const v = vertices(todos);
  diag.vertices = v.length;
  /* na 2ª tentativa da hora (meia hora) o fracasso aparece como ❌ no GitHub */
  if (v.length < 4) { fim('poucos vencimentos de janeiro na fonte (' + v.length + '); nada enviado', MINUTO >= 30 && !TESTE && !FORCAR); process.exit(process.exitCode || 0); }

  const par = pareceParado(v);
  diag.parado = par;
  if (par.parado && !FORCAR) { fim('sem variação/volume em nenhum contrato: provável feriado ou sem pregão; nada enviado'); process.exit(0); }

  const texto = mensagem(v);
  diag.mensagem_chars = texto.length;
  await enviarTexto(texto, { teste: TESTE });
  if (!TESTE) gravar('juros.json', { data: HOJE, slots: Object.assign(slots, { [HORA]: true }), hora: HORA, fonte: 'TradingView (atraso ~15 min)', curva: v.map((x) => ({ codigo: x.codigo, venc: x.venc, ano: x.ano, taxa: x.taxa, var_pp: Math.round(x.dif * 1000) / 1000 })) });
  fim('edição das ' + HORA + 'h enviada (' + v.length + ' vencimentos)');
} catch (e) {
  fim(e.message, true);
}
