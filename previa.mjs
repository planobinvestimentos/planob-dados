/* PARCIAL DO PREGÃO (de 2 em 2 horas, às 12h, 14h e 16h, Brasília; PREVIA_INTERVALO e PREVIA_ATE mudam isso): maiores altas e baixas "até o momento" de ações, FIIs de tijolo, FIIs de papel e ETFs
   (as criptomoedas NÃO entram mais aqui: têm imagem própria, no painel do mercado, em futuros-imagem.mjs; para voltar a incluir no texto da parcial use PREVIA_CRIPTO_HORAS=15). Roda no GitHub Actions (.github/workflows/previa.yml), segunda a sexta.
   Cada hora sai uma única vez (estado por hora em saida/previa.json); o workflow tenta de novo na meia hora se a primeira tentativa da hora falhar.
   Diferença para o fechamento das 20h: o fechamento usa o arquivo oficial da B3 (só sai depois do pregão). Aqui as cotações vêm de uma fonte gratuita
   com atraso de uns 15 minutos. Por isso a prévia mostra só 3 de cada lado e avisa que o fechamento completo sai às 20h.
   Fontes (nesta ordem, sem chave e sem custo):
     1) TradingView (scanner): uma única consulta traz o mercado brasileiro inteiro, com preço, variação do dia e volume.
     2) Yahoo Finance (gráfico de cada código): reserva, usada só se a 1 falhar. Consulta um código por vez.
   Se nenhuma fonte entregar dados confiáveis (ou se não houve pregão hoje), NADA é enviado e o motivo fica em saida/previa-diag.json.
   MODO=fechamento (workflow fechamento-rapido.yml): o MESMO script envia o FECHAMENTO RÁPIDO por volta das 18h20 (altas e baixas do dia, 5 de cada lado, com as mesmas
   fontes e filtros). Sai uma única vez (slot "fech" em saida/previa.json) e o fechamento oficial das 20h (telegram.mjs) NÃO é enviado se este já saiu: nada duplicado.
   Se o rápido não sair (fonte fora do ar, feriado), o oficial continua como reserva, a partir das 20h.
   Variáveis: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Opcionais: TESTE=1 (só mostra no log, ignora horário e não grava estado), FORCAR=1 (ignora horário e o "já enviou hoje"). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dorme, cripto } from './mercado.mjs';
import { enviarTexto, num, brl, dataBR } from './proventos-msg.mjs';
import { ETFS_DESTAQUE, ETFS_EXTERIOR, cotacoesExterior } from './lib.mjs';
import { DESEJO_SEXTA, ehSexta } from './elpis-dica.mjs';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = process.env.SAIDA_DIR || path.join(RAIZ, 'saida');
const TESTE = process.env.TESTE === '1';
const FORCAR = process.env.FORCAR === '1';
const TV_URL = process.env.TV_URL || 'https://scanner.tradingview.com/brazil/scan';
const YAHOO_URL = process.env.YAHOO_URL || 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; PlanoB-Investimentos-aviso/1.0; uso educacional)' };
const RODAPE = 'Conteúdo educacional. Não é recomendação de investimento.';
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const FECH = process.env.MODO === 'fechamento';                                                                      // fechamento rápido (18h20 em diante)
const QUANTOS = Number(process.env.PREVIA_QUANTOS) || (FECH ? 5 : 3);
const H_INI = Number(process.env.PREVIA_DE) || 12, H_FIM = Number(process.env.PREVIA_ATE) || 16;                       // janela: das 12h às 16h (inclusive)
const INTERVALO = Number(process.env.PREVIA_INTERVALO) || 2;                                                          // a cada 2 horas: 12h, 14h e 16h
const HORAS_PREVIA = [];
for (let h = H_INI; h <= H_FIM; h += INTERVALO) HORAS_PREVIA.push(h + 'h');
const HORAS_TXT = HORAS_PREVIA.length > 1 ? HORAS_PREVIA.slice(0, -1).join(', ') + ' e ' + HORAS_PREVIA[HORAS_PREVIA.length - 1] : HORAS_PREVIA.join('');
const CRIPTO_HORAS = String(process.env.PREVIA_CRIPTO_HORAS || '').split(',').map((x) => Number(x.trim())).filter(Boolean);   // horas em que a mensagem inclui criptomoedas

/* agora em Brasília (UTC-3, sem horário de verão) */
const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T18:00:00Z') : new Date(Date.now() - 3 * 3600 * 1000);
const HOJE = agora.toISOString().slice(0, 10);
const DOW = agora.getUTCDay();
const HORA = process.env.HORA_TESTE ? Number(process.env.HORA_TESTE) : agora.getUTCHours();
const MINUTO = process.env.MINUTO_TESTE ? Number(process.env.MINUTO_TESTE) : agora.getUTCMinutes();
/* fração do pregão já decorrida (10h às ~18h): o volume mínimo cresce ao longo do dia (12h = 25%, 17h = 89%) */
const FRACAO = FECH ? 1 : Math.min(1, Math.max(0.15, (HORA + MINUTO / 60 - 10) / 7.9));
const CHAVE = FECH ? 'fech' : HORA;                      // chave do envio em saida/previa.json
const H_FECH_INI = 18 * 60 + 15, H_FECH_FIM = 19 * 60 + 59;   // fechamento rápido: de 18h15 (atraso da fonte ~15 min após o fim do pregão às 18h00) até 19h59

const lerJson = (arq, padrao = null) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, arq), 'utf8')); } catch (e) { return padrao; } };
const gravar = (arq, obj) => { try { fs.mkdirSync(SAIDA, { recursive: true }); fs.writeFileSync(path.join(SAIDA, arq), JSON.stringify(obj, null, 1)); } catch (e) { console.warn('aviso: não consegui gravar', arq + ':', e.message); } };
const pct = (v) => (v >= 0 ? '+' : '−') + num(Math.abs(v)) + '%';
const usdAuto = (v) => 'US$ ' + num(v, v >= 1000 ? 0 : v >= 1 ? 2 : v >= 0.01 ? 4 : 6);
const TICKER = /^[A-Z]{4}\d{1,2}$/;

/* ---------- fonte 1: TradingView (mercado inteiro numa consulta) ---------- */
async function fonteTradingView() {
  const corpo = {
    filter: [], options: { lang: 'pt' }, markets: ['brazil'], symbols: { query: { types: [] }, tickers: [] },
    columns: ['name', 'close', 'change', 'volume'], sort: { sortBy: 'volume', sortOrder: 'desc' }, range: [0, 1500],
  };
  const r = await fetch(TV_URL, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, UA), body: JSON.stringify(corpo), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('TradingView HTTP ' + r.status);
  const j = await r.json();
  const cot = {};
  for (const it of (j && j.data) || []) {
    const [nome, p, v, vol] = it.d || [];
    const tk = String(nome || '').toUpperCase();
    if (!TICKER.test(tk) || !(p > 0) || !isFinite(v)) continue;
    cot[tk] = { p: Number(p), v: Number(v), vol: (Number(vol) || 0) * Number(p) };   // volume em R$ (aproximado: quantidade x preço atual)
  }
  return cot;
}

/* ---------- fonte 2: Yahoo Finance, um código por vez (reserva) ---------- */
async function fonteYahoo(codigos) {
  const cot = {}, fila = [...codigos];
  let falhasSeguidas = 0, abortar = false;
  const um = async (tk) => {
    if (abortar) return;
    try {
      const r = await fetch(YAHOO_URL + tk + '.SA?range=1d&interval=1d', { headers: Object.assign({ Accept: 'application/json' }, UA), signal: AbortSignal.timeout(15000) });
      if (r.status === 404) { falhasSeguidas = 0; return; }                 // código que o Yahoo não conhece: normal, segue
      if (!r.ok) { if (++falhasSeguidas >= 8) abortar = true; return; }       // 403/429/5xx seguidos = bloqueio: para
      falhasSeguidas = 0;
      const m = (((await r.json()).chart || {}).result || [])[0];
      const meta = m && m.meta;
      if (!meta) return;
      const p = meta.regularMarketPrice, ant = meta.previousClose || meta.chartPreviousClose;
      const dia = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000 - 3 * 3600 * 1000).toISOString().slice(0, 10) : '';
      if (!(p > 0) || !(ant > 0) || dia !== HOJE) return;                 // cotação de outro dia: ignora
      cot[tk] = { p, v: (p / ant - 1) * 100, vol: (meta.regularMarketVolume || 0) * p };
    } catch (e) { if (++falhasSeguidas >= 8) abortar = true; }
  };
  await Promise.all(Array.from({ length: 6 }, async () => { while (fila.length && !abortar) { await um(fila.shift()); await dorme(120); } }));
  if (abortar) console.warn('aviso: Yahoo recusou várias consultas seguidas; parei.');
  return cot;
}

/* ---------- listas e ranking ---------- */
function carregarListas() {
  let l = {};
  try { l = JSON.parse(fs.readFileSync(path.join(RAIZ, 'listas-bolsa.json'), 'utf8')); } catch (e) { throw new Error('não consegui ler listas-bolsa.json: ' + e.message); }
  const conj = (a) => new Set((a || []).map((x) => String(x).trim().toUpperCase()));
  const f = Object.assign({ minVolumeAcoes: 3000000, minVolumeFiis: 400000, minVolumeEtfs: 400000, variacaoMaxima: 40 }, l.filtros || {});
  const tijolo = conj(l.fiisTijolo), papel = conj(l.fiisPapel), etfs = conj(l.etfs);
  /* ações = códigos do cadastro (universo.json) que não são FII nem ETF das listas */
  const uni = lerJson('universo.json', { itens: {} }).itens || {};
  const acoes = new Set(Object.entries(uni).filter(([tk, it]) => it.cls === 'Ação' && !it.sumiu && !tijolo.has(tk) && !papel.has(tk) && !etfs.has(tk)).map(([tk]) => tk));
  return { f, tijolo, papel, etfs, acoes };
}
/* o dia ainda não acabou: o volume mínimo é a fração do exigido no fechamento que corresponde à parte do pregão já decorrida (FRACAO) */
function ranking(cot, conjunto, minVol, f) {
  const lista = [];
  for (const tk of conjunto) {
    const c = cot[tk];
    if (!c || c.vol < minVol * FRACAO) continue;
    if (Math.abs(c.v) > f.variacaoMaxima) { console.warn('prévia: ignorado por variação extrema (possível desdobramento ou evento):', tk, c.v.toFixed(1) + '%'); continue; }
    lista.push({ t: tk, p: c.p, v: Math.round(c.v * 100) / 100 });
  }
  return {
    altas: [...lista].sort((a, b) => b.v - a.v).filter((x) => x.v > 0).slice(0, QUANTOS),
    quedas: [...lista].sort((a, b) => a.v - b.v).filter((x) => x.v < 0).slice(0, QUANTOS),
    universo: lista.length,
  };
}

/* sem pregão hoje (feriado) ou dado velho: as cotações ficam IGUAIS ao fechamento de ontem (d1.json). Se quase tudo está igual, não envia. */
function pareceParado(cot) {
  const d1 = (lerJson('d1.json', {}) || {}).p || {};
  let n = 0, iguais = 0;
  for (const [tk, c] of Object.entries(cot)) {
    if (!(c.vol > 0) || !(d1[tk] > 0)) continue;
    n++;
    if (Math.abs(c.p / d1[tk] - 1) < 0.0005) iguais++;
  }
  return { n, iguais, parado: n >= 100 && iguais / n > 0.9 };
}

/* ---------- mensagem ---------- */
function mensagem(g, ibov, destaque, cr, incluirCripto) {
  const linhas = (lista, e) => lista.map((x) => e + ' ' + x.t + ': ' + brl(x.p) + ' (' + pct(x.v) + ')');
  const bloco = (nome, r) => (r && (r.altas.length || r.quedas.length) ? [nome, ...linhas(r.altas, '🟢'), ...linhas(r.quedas, '🔻')].join('\n') : '');
  const blocos = [bloco('🏢 AÇÕES', g.acoes), bloco('🏠 FIIs DE TIJOLO', g.fiisTijolo), bloco('📄 FIIs DE PAPEL', g.fiisPapel), bloco('📦 ETFs', g.etfs)].filter(Boolean);
  const dest = destaque.length ? '⭐ ETFs EM DESTAQUE\n' + destaque.map((x) => x.t + ': ' + brl(x.p) + ' (' + pct(x.v) + ')').join('\n') : '';
  const cripBlocos = [];
  if (cr && cr.btc) cripBlocos.push('₿ Bitcoin: ' + usdAuto(cr.btc.p) + (isFinite(cr.btc.v) ? ' (' + pct(cr.btc.v) + ')' : ''));
  if (cr && (cr.altas.length || cr.quedas.length)) cripBlocos.push([...cr.altas.map((x) => '🟢 ' + x.s + ': ' + usdAuto(x.p) + ' (' + pct(x.v) + ')'), ...cr.quedas.map((x) => '🔻 ' + x.s + ': ' + usdAuto(x.p) + ' (' + pct(x.v) + ')')].join('\n'));
  const cripto = incluirCripto && cripBlocos.length ? '🪙 CRIPTO (últimas 24h, top 50)\n' + cripBlocos.join('\n') : '';
  return [
    '⏱️ PARCIAL DO PREGÃO · ' + DIAS[DOW] + ', ' + dataBR(HOJE) + ' · ' + HORA + 'h',
    'Como o mercado está até agora: ' + QUANTOS + ' maiores altas (🟢) e ' + QUANTOS + ' maiores baixas (🔻) de cada grupo. 🔁 Repetição proposital: sai de ' + INTERVALO + ' em ' + INTERVALO + ' horas, às ' + HORAS_TXT + '. O fechamento do dia sai logo depois das 18h.',
    ibov ? 'Ibovespa (via BOVA11): ' + pct(ibov.v) : '',
    blocos.join('\n\n'), dest, cripto,
    'Ações, FIIs e ETFs: cotações com atraso de cerca de 15 minutos, de fonte de terceiros.' + (incluirCripto && cripto ? ' Cripto: CoinGecko.' : ''),
    RODAPE,
  ].filter(Boolean).join('\n\n');
}

/* fechamento rápido: duas mensagens (altas e baixas), no mesmo formato do fechamento oficial das 20h, mas avisando que a fonte é de terceiros */
function mensagensFechamento(g, ibov, destaque, exterior = []) {
  const linhas = (lista, e) => lista.map((x) => e + ' ' + x.t + ': ' + brl(x.p) + ' (' + pct(x.v) + ')');
  const nomes = [['🏢 AÇÕES', g.acoes], ['🏠 FIIs DE TIJOLO', g.fiisTijolo], ['📄 FIIs DE PAPEL', g.fiisPapel], ['📦 ETFs', g.etfs]];
  const fonteAviso = 'Números do fechamento de hoje, de fonte de terceiros (atraso de cerca de 15 minutos); podem diferir em centavos dos números oficiais da B3, que só saem à noite.';
  const monta = (altas) => {
    const k = altas ? 'altas' : 'quedas', e = altas ? '🟢' : '🔻';
    const blocos = nomes.map(([n, r]) => (r && r[k].length ? [n, ...linhas(r[k], e)].join('\n') : '')).filter(Boolean);
    const linhasDest = [...destaque.map((x) => x.t + ': fechamento ' + brl(x.p) + ' (' + pct(x.v) + ')'), ...exterior.map((x) => x.t + ': fechamento ' + usdAuto(x.p) + ' (' + pct(x.v) + ') · EUA')];
    const dest = altas && linhasDest.length ? '⭐ ETFs EM DESTAQUE\n' + linhasDest.join('\n') : '';
    if (!blocos.length && !dest) return '';
    return [
      '🚪 FECHAMENTO (' + dataBR(HOJE) + ')\n' + (altas ? '⬆️ Maiores altas' : '⬇️ Maiores baixas'),
      altas && ibov ? 'Ibovespa (via BOVA11): ' + pct(ibov.v) : '',
      blocos.join('\n\n'), dest,
      altas ? '' : fonteAviso + '\nDólar e criptomoedas saem às 20h. Ranking completo: https://planobinvestimentos.com/cotacoes/bolsa/',
      altas ? '' : RODAPE,
    ].filter(Boolean).join('\n\n');
  };
  const msgs = [monta(true), monta(false)].filter(Boolean);
  if (msgs.length && ehSexta(HOJE)) msgs[msgs.length - 1] += '\n\n' + DESEJO_SEXTA;   // sexta: o fechamento termina com o desejo de bom final de semana
  return msgs;
}

/* ---------- principal ---------- */
const diag = { gerado: new Date().toISOString(), hoje: HOJE, hora: HORA };
const estado = lerJson('previa.json', {});
const slots = estado.data === HOJE && estado.slots ? Object.assign({}, estado.slots) : {};   // horas já enviadas hoje, ex.: { "12": true, "13": true }
const fim = (motivo, erro = false) => { diag.resultado = motivo; console.log(erro ? 'ERRO:' : 'prévia:', motivo); if (!TESTE) gravar('previa-diag.json', diag); if (erro) process.exitCode = 1; };

try {
  if (!TESTE && !FORCAR) {
    if (DOW === 0 || DOW === 6) { console.log('prévia: fim de semana, a bolsa não abre.'); process.exit(0); }
    if (FECH) {
      const min = HORA * 60 + MINUTO;
      if (min < H_FECH_INI || min > H_FECH_FIM) { console.log('fechamento rápido: janela das 18h15 às 19h59 (agora ' + HORA + 'h' + String(MINUTO).padStart(2, '0') + '); nada a fazer.'); process.exit(0); }
    } else if (HORA < H_INI || HORA > H_FIM || (HORA - H_INI) % INTERVALO !== 0) { console.log('prévia: fora dos horários ' + HORAS_TXT + ' (agora ' + HORA + 'h); nada a fazer.'); process.exit(0); }
    if (slots[CHAVE]) { console.log(FECH ? 'fechamento rápido: já foi enviado hoje.' : 'prévia: a edição das ' + HORA + 'h já foi enviada.'); process.exit(0); }
  }
  const L = carregarListas();
  diag.acoes_no_cadastro = L.acoes.size;
  if (!L.acoes.size) console.warn('aviso: cadastro de ações (universo.json) vazio; o bloco de ações não aparece.');

  let cot = {}, fonte = '';
  try { cot = await fonteTradingView(); fonte = 'TradingView'; diag.tradingview = Object.keys(cot).length; }
  catch (e) { console.warn('aviso TradingView:', e.message); diag.tradingview = 'falhou: ' + e.message; }
  if (Object.keys(cot).length < 150) {
    const codigos = [...new Set([...L.acoes, ...L.tijolo, ...L.papel, ...L.etfs, ...ETFS_DESTAQUE, 'BOVA11'])];
    console.log('TradingView sem dados suficientes; tentando o Yahoo para', codigos.length, 'códigos...');
    cot = await fonteYahoo(codigos); fonte = 'Yahoo Finance'; diag.yahoo = Object.keys(cot).length;
  }
  diag.fonte = fonte; diag.cotacoes = Object.keys(cot).length;
  /* na 2ª tentativa da hora (a da meia hora) o fracasso aparece como ❌ no GitHub */
  if (Object.keys(cot).length < 150) { fim('sem cotações suficientes (' + Object.keys(cot).length + '); nada enviado', (FECH ? HORA >= 19 : MINUTO >= 30) && !TESTE && !FORCAR); process.exit(process.exitCode || 0); }

  const par = pareceParado(cot);
  diag.comparacao_d1 = par;
  if (par.parado && !FORCAR) { fim('cotações iguais ao fechamento de ontem (' + par.iguais + ' de ' + par.n + '): provável feriado ou sem pregão; nada enviado'); process.exit(0); }

  const g = {
    acoes: ranking(cot, L.acoes, L.f.minVolumeAcoes, L.f),
    fiisTijolo: ranking(cot, L.tijolo, L.f.minVolumeFiis, L.f),
    fiisPapel: ranking(cot, L.papel, L.f.minVolumeFiis, L.f),
    etfs: ranking(cot, L.etfs, L.f.minVolumeEtfs, L.f),
  };
  diag.universo = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.universo]));
  const destaque = ETFS_DESTAQUE.filter((tk) => cot[tk]).map((tk) => ({ t: tk, p: cot[tk].p, v: cot[tk].v }));
  const ibov = cot.BOVA11 ? { v: cot.BOVA11.v } : null;
  if (!Object.values(g).some((x) => x.altas.length || x.quedas.length)) { fim('nenhum ativo passou nos filtros; nada enviado'); process.exit(0); }

  if (FECH) {
    let exterior = [];
    try { const av = []; exterior = await cotacoesExterior(ETFS_EXTERIOR, HOJE, av); diag.exterior = exterior.length + ' de ' + ETFS_EXTERIOR.length + (av.length ? ' (' + av.join('; ') + ')' : ''); }
    catch (e) { diag.exterior = 'falhou: ' + e.message; }
    const msgs = mensagensFechamento(g, ibov, destaque, exterior);
    diag.mensagem_chars = msgs.reduce((s, m) => s + m.length, 0);
    for (const m of msgs) await enviarTexto(m, { teste: TESTE });
    if (!TESTE) { slots.fech = true; gravar('previa.json', { data: HOJE, slots, fonte }); }
    fim('fechamento rápido enviado (fonte: ' + fonte + ')');
    process.exit(process.exitCode || 0);
  }
  const incluirCripto = CRIPTO_HORAS.includes(HORA);
  const cr = incluirCripto ? await cripto(null, null, QUANTOS) : null;
  const texto = mensagem(g, ibov, destaque, cr, incluirCripto);
  diag.mensagem_chars = texto.length;
  await enviarTexto(texto, { teste: TESTE });
  if (!TESTE) { slots[CHAVE] = true; gravar('previa.json', { data: HOJE, slots, fonte }); }
  fim('edição das ' + HORA + 'h enviada (fonte: ' + fonte + ')');
} catch (e) {
  fim(e.message, true);
}
