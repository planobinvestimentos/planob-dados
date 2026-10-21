/* PAINEL DO MERCADO ("futuros imagem"): imagens com a marca do Plano B, enviadas ao canal do Telegram. Roda no GitHub Actions. Dois modos (variável MODO):
   MODO=lote (padrão; workflow futuros-imagem.yml, segunda a sexta, às 11h30, 14h30 e 16h30 de Brasília): UM ÁLBUM (1 notificação) com até 4 imagens:
     1) Índices setoriais da B3 (ICON, IEEX, INDX, IMOB, IFNC, IMAT; o TradingView não tem o UTIL): variação do dia e pontos. Fonte: TradingView (~15 min de atraso).
     2) Criptomoedas: Bitcoin em destaque (24 h e 7 dias) + as 9 maiores seguintes (24 h). Fonte: CoinGecko.
     3) Commodities: petróleo WTI e Brent, gás, ouro, prata, minério de ferro (Dalian), cobre, milho, boi gordo, soja e trigo. Fontes: CNBC/Yahoo/Stooq, Sina/Eastmoney, B3.
     4) Dólar no mundo: DXY + dólar contra 23 moedas emergentes, com média e contagem de altas/quedas. Fontes: CNBC/Yahoo/Stooq.
   MODO=medo (workflow medo-ganancia.yml, todos os dias, às 8h00 e 21h30): imagem do Índice de Medo e Ganância das criptomoedas (alternative.me), com agora, ontem, semana e mês.
   Regras: cada edição sai uma única vez (saida/futuros-imagem.json e saida/medo-ganancia.json); o lote só sai em dia de pregão (compara as cotações com o fechamento de ontem, como a parcial);
   se alguma fonte falhar na 1ª tentativa, nada sai e a 2ª tentativa (20 minutos depois) envia o que estiver disponível. Imagem sem dados suficientes é omitida do álbum.
   O logo é opcional: se existir imagens/logo.png (PNG, de preferência com fundo transparente) ele aparece no cabeçalho de todas as imagens.
   As imagens são desenhadas por imagem-futuros.py (matplotlib).
   Variáveis: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Opcionais:
     TESTE=1  -> ignora horário e regras e manda as imagens SÓ para o seu Telegram privado (TELEGRAM_ALERTA_CHAT_ID); não grava estado (o diagnóstico sempre é gravado);
     FORCAR=1 -> ignora horário, feriado e o "já enviou" e envia ao canal agora;
     FUTUROS_LOTES (padrão "11:30,14:30,16:30"), MEDO_HORARIOS (padrão "08:00,21:30"). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pegarComRetry, FORA } from './mercado.mjs';
import { dataBR, RODAPE, ASSINATURA } from './proventos-msg.mjs';
import { pegar, cotar, minerioDalian, futuroB3, COMMODITIES, MOEDAS, DXY } from './cotacoes-globais.mjs';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = process.env.SAIDA_DIR || path.join(RAIZ, 'saida');
const MODO = process.env.MODO === 'medo' ? 'medo' : 'lote';
const TESTE = process.env.TESTE === '1';
const FORCAR = process.env.FORCAR === '1';
const TV_URL = process.env.TV_URL || 'https://scanner.tradingview.com/brazil/scan';
const GECKO_URL = process.env.SETORES_GECKO_URL || 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&price_change_percentage=24h,7d';
const MEDO_URL = process.env.MEDO_URL || 'https://api.alternative.me/fng/?limit=31&format=json';
const API_TG = process.env.TELEGRAM_API || 'https://api.telegram.org';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; PlanoB-Investimentos-aviso/1.0; uso educacional)' };
const LOGO = path.join(RAIZ, 'imagens', 'logo.png');
const TICKER = /^[A-Z]{4}\d{1,2}$/;
const INDICES = [
  { cod: 'ICON', nome: 'Consumo' }, { cod: 'IEEX', nome: 'Energia elétrica' }, { cod: 'INDX', nome: 'Industrial' },
  { cod: 'IMOB', nome: 'Imobiliário' }, { cod: 'IFNC', nome: 'Financeiro' }, { cod: 'IMAT', nome: 'Materiais básicos' },
];
const MIN_INDICES = 5, MIN_COMMODITIES = 6, MIN_MOEDAS = 15;
const JANELA = 45, ULTIMA = 18;   // minutos: a edição vale por 45 min a partir do horário; a partir do minuto 18 é a última tentativa

/* agora em Brasília (UTC-3, sem horário de verão) */
const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T18:00:00Z') : new Date(Date.now() - 3 * 3600 * 1000);
const HOJE = agora.toISOString().slice(0, 10);
const DOW = agora.getUTCDay();
const HORA = process.env.HORA_TESTE ? Number(process.env.HORA_TESTE) : agora.getUTCHours();
const MINUTO = process.env.MINUTO_TESTE ? Number(process.env.MINUTO_TESTE) : agora.getUTCMinutes();
const HHMM = String(HORA).padStart(2, '0') + ':' + String(MINUTO).padStart(2, '0');
const AGORA_MIN = HORA * 60 + MINUTO;
const minutos = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const hmBonito = (hm) => hm.slice(0, 2).replace(/^0/, '') + 'h' + hm.slice(3, 5);

const ARQ = MODO === 'medo' ? 'medo-ganancia' : 'futuros-imagem';
const lerJson = (arq, padrao = null) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, arq), 'utf8')); } catch (e) { return padrao; } };
const gravar = (arq, obj) => { try { fs.mkdirSync(SAIDA, { recursive: true }); fs.writeFileSync(path.join(SAIDA, arq), JSON.stringify(obj, null, 1)); } catch (e) { console.warn('aviso: não consegui gravar', arq + ':', e.message); } };
const diag = { gerado: new Date().toISOString(), hoje: HOJE, hora: HHMM, modo: MODO };
const fim = (motivo, erro = false) => { diag.resultado = motivo; console.log(erro ? 'ERRO:' : 'painel:', motivo); gravar(ARQ + '-diag.json', diag); if (erro) process.exitCode = 1; };
const sair = (msg) => { console.log(msg); process.exit(0); };

/* qual edição estamos: a mais recente cujo horário já passou há menos de JANELA minutos */
function edicao(horarios) {
  for (const hm of horarios) { const m = minutos(hm); if (AGORA_MIN >= m && AGORA_MIN < m + JANELA) return { id: hm.replace(':', ''), hm, min: m, ultima: AGORA_MIN - m >= ULTIMA }; }
  return null;
}

/* ---------- TradingView ---------- */
async function tv(corpo) {
  const r = await fetch(TV_URL, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, UA), body: JSON.stringify(corpo), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('TradingView HTTP ' + r.status);
  return r.json();
}

/* a bolsa abriu hoje? (feriado: as cotações ficam iguais ao fechamento de ontem, d1.json). Na dúvida (fonte fora do ar), deixa seguir. */
async function pregaoAberto() {
  try {
    const j = await tv({ filter: [], options: { lang: 'pt' }, markets: ['brazil'], symbols: { query: { types: [] }, tickers: [] }, columns: ['name', 'close', 'change', 'volume'], sort: { sortBy: 'volume', sortOrder: 'desc' }, range: [0, 80] });
    const d1 = (lerJson('d1.json', {}) || {}).p || {};
    let n = 0, iguais = 0;
    for (const it of (j && j.data) || []) {
      const [nome, p] = it.d || [];
      const tk = String(nome || '').toUpperCase();
      if (!TICKER.test(tk) || !(p > 0) || !(d1[tk] > 0)) continue;
      n++; if (Math.abs(p / d1[tk] - 1) < 0.0005) iguais++;
    }
    diag.pregao = { comparaveis: n, iguais };
    if (n >= 15 && iguais / n > 0.8) return false;
  } catch (e) { diag.pregao = 'não deu para conferir: ' + e.message; }
  return true;
}

/* ---------- 1) setores ---------- */
async function dadosSetores() {
  const achados = {};
  const guardar = (j, origem) => {
    for (const it of (j && j.data) || []) {
      const [nome, p, v] = it.d || [];
      const cod = String(nome || '').toUpperCase().replace(/^.*:/, '');
      if (!INDICES.some((i) => i.cod === cod) || achados[cod]) continue;
      if (!(Number(p) > 0) || !isFinite(Number(v)) || Math.abs(Number(v)) > 20) continue;
      achados[cod] = { p: Number(p), v: Number(v), s: it.s || '', origem };
    }
  };
  const dg = {};
  try {
    const tickers = ['BMFBOVESPA', 'BVMF'].flatMap((b) => INDICES.map((i) => b + ':' + i.cod));
    guardar(await tv({ filter: [], options: { lang: 'pt' }, markets: ['brazil'], symbols: { query: { types: [] }, tickers }, columns: ['name', 'close', 'change'], range: [0, 50] }), 'simbolo');
  } catch (e) { dg.simbolos = 'falhou: ' + e.message; }
  if (Object.keys(achados).length < INDICES.length) {
    try {
      const j = await tv({ filter: [], options: { lang: 'pt' }, markets: ['brazil'], symbols: { query: { types: ['index'] }, tickers: [] }, columns: ['name', 'close', 'change', 'description'], range: [0, 500] });
      guardar(j, 'lista');
      dg.lista_total = ((j && j.data) || []).length;
      dg.lista_nomes = ((j && j.data) || []).map((x) => (x.d || [])[0]).slice(0, 120);
    } catch (e) { dg.lista = 'falhou: ' + e.message; }
  }
  dg.achados = Object.fromEntries(Object.entries(achados).map(([k, v]) => [k, { v: v.v, s: v.s, origem: v.origem }]));
  dg.faltando = INDICES.filter((i) => !achados[i.cod]).map((i) => i.cod);
  diag.setores = dg;
  const lista = INDICES.filter((i) => achados[i.cod]).map((i) => ({ nome: i.nome, cod: i.cod, v: Math.round(achados[i.cod].v * 100) / 100, pts: achados[i.cod].p })).sort((a, b) => b.v - a.v);
  if (lista.length < MIN_INDICES) throw new Error('só ' + lista.length + ' de ' + INDICES.length + ' índices setoriais vieram (faltam ' + dg.faltando.join(', ') + ')');
  return { tipo: 'setores', titulo: 'ÍNDICES SETORIAIS B3', sub: sub('variação do dia'), itens: lista, rodape: 'Cotações com atraso de ~15 min · fonte: TradingView' };
}

/* ---------- 2) criptomoedas ---------- */
async function dadosCripto() {
  const j = await pegarComRetry(GECKO_URL);
  const v24 = (c) => (c.price_change_percentage_24h_in_currency != null ? c.price_change_percentage_24h_in_currency : c.price_change_percentage_24h);
  const l = (Array.isArray(j) ? j : []).filter((c) => {
    const s = String(c.symbol || '').toLowerCase();
    if (FORA.has(s) || !(c.current_price > 0) || !isFinite(v24(c))) return false;
    return !(c.current_price > 0.97 && c.current_price < 1.03 && Math.abs(v24(c)) < 1);   // parece stablecoin
  });
  const btc = l.find((c) => String(c.symbol).toLowerCase() === 'btc');
  if (!btc) throw new Error('Bitcoin não veio na resposta da CoinGecko');
  const outras = l.filter((c) => c !== btc).slice(0, 9).map((c) => ({ nome: String(c.name), s: String(c.symbol).toUpperCase(), v: Math.round(v24(c) * 100) / 100, p: c.current_price }));
  const v7 = btc.price_change_percentage_7d_in_currency;
  return { tipo: 'cripto', titulo: 'CRIPTOMOEDAS', sub: sub('24 horas e 7 dias'), btc: { nome: 'Bitcoin', v: Math.round(v24(btc) * 100) / 100, p: btc.current_price, v7: v7 != null && isFinite(v7) ? Math.round(v7 * 100) / 100 : null }, itens: outras, rodape: 'Fonte: CoinGecko · maiores moedas por valor de mercado, sem stablecoins' };
}

/* ---------- 3) commodities ---------- */
async function dadosCommodities() {
  const dg = {};
  const todos = COMMODITIES.flatMap((g) => g.itens);
  const got = await cotar(todos.filter((i) => i.c), dg);
  const dalian = await minerioDalian(dg, new Date(Date.now()));
  if (dalian) got.minerio = dalian;
  for (const it of todos.filter((i) => i.propria === 'b3')) { const q = await futuroB3(it.prefixo, it.meses, dg); if (q) got[it.id] = q; }
  const grupos = COMMODITIES.map((g) => ({
    nome: g.nome, cor: g.cor,
    itens: g.itens.filter((i) => got[i.id]).map((i) => ({ nome: i.n, un: i.un, p: got[i.id].p * (i.fator || 1), v: Math.round(got[i.id].v * 100) / 100, dec: i.dec != null ? i.dec : 2 })),
  }));
  dg.itens_ok = todos.filter((i) => got[i.id]).map((i) => i.id + ':' + got[i.id].fonte);
  dg.itens_faltando = todos.filter((i) => !got[i.id]).map((i) => i.id);
  diag.commodities = dg;
  const n = grupos.reduce((s, g) => s + g.itens.length, 0);
  if (n < MIN_COMMODITIES) throw new Error('só ' + n + ' de ' + todos.length + ' commodities vieram (faltam ' + dg.itens_faltando.join(', ') + ')');
  return { tipo: 'commodities', titulo: 'COMMODITIES', sub: sub('variação do dia'), grupos, rodape: 'Futuros · fontes de terceiros (CNBC, Yahoo, B3, Dalian) com atraso de alguns minutos' };
}

/* ---------- 4) dólar no mundo ---------- */
async function dadosDolar() {
  const dg = {};
  const got = await cotar([...MOEDAS, DXY], dg);
  const itens = MOEDAS.filter((m) => got[m.id]).map((m) => ({ nome: m.n, cod: m.cod, v: Math.round(got[m.id].v * 100) / 100, p: got[m.id].p })).sort((a, b) => a.v - b.v);
  dg.moedas_ok = itens.length;
  dg.moedas_faltando = MOEDAS.filter((m) => !got[m.id]).map((m) => m.cod);
  dg.dxy = got.dxy ? got.dxy.fonte : 'indisponível';
  diag.dolar = dg;
  if (itens.length < MIN_MOEDAS) throw new Error('só ' + itens.length + ' de ' + MOEDAS.length + ' moedas vieram (faltam ' + dg.moedas_faltando.join(', ') + ')');
  return { tipo: 'dolar', titulo: 'DÓLAR NO MUNDO', sub: sub('variação do dia'), dxy: got.dxy ? { v: Math.round(got.dxy.v * 100) / 100, p: got.dxy.p } : null, itens, destaque: 'BRL', rodape: 'Fontes de terceiros (CNBC, Yahoo) · variação do dia · atraso de alguns minutos' };
}

/* ---------- medo e ganância ---------- */
const CLASSES = [[25, 'Medo extremo'], [47, 'Medo'], [55, 'Neutro'], [76, 'Ganância'], [101, 'Ganância extrema']];     // mesmas faixas do alternative.me
const classe = (v) => CLASSES.find(([lim]) => v < lim)[1];
async function dadosMedo() {
  const j = await pegarComRetry(MEDO_URL);
  const d = (j && j.data) || [];
  const val = (k) => (d[k] && isFinite(Number(d[k].value)) ? Number(d[k].value) : null);
  if (val(0) == null) throw new Error('alternative.me sem leitura atual');
  diag.leitura = { data: d[0].timestamp ? new Date(Number(d[0].timestamp) * 1000).toISOString().slice(0, 10) : '', valor: val(0), proxima_atualizacao_em_segundos: d[0].time_until_update || null };
  const hist = [['Agora', 0], ['Ontem', 1], ['Semana passada', 7], ['Mês passado', 30]].filter(([, k]) => val(k) != null).map(([rot, k]) => ({ rot, valor: val(k), classe: classe(val(k)) }));
  return { tipo: 'medo', titulo: 'MEDO E GANÂNCIA', sub: sub('criptomoedas'), valor: val(0), classe: classe(val(0)), hist, rodape: 'Fonte: alternative.me · índice de medo e ganância das criptomoedas' };
}

/* ---------- imagem e envio ---------- */
const sub = (txt) => dataBR(HOJE) + ' · ' + HHMM + ' (BRT) · ' + txt;
function desenhar(spec, nome) {
  if (fs.existsSync(LOGO)) spec.logo = LOGO;
  const ent = path.join(os.tmpdir(), 'planob-' + nome + '.json'), png = path.join(os.tmpdir(), 'planob-' + nome + '.png');
  fs.writeFileSync(ent, JSON.stringify(spec));
  execFileSync('python3', [path.join(RAIZ, 'imagem-futuros.py'), ent, png], { timeout: 90000, stdio: ['ignore', 'inherit', 'inherit'] });
  return png;
}
const destino = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = TESTE ? process.env.TELEGRAM_ALERTA_CHAT_ID : process.env.TELEGRAM_CHAT_ID;
  return { token, chat, semDestino: TESTE && (!token || !chat) };
};
async function enviar(pngs, legenda) {
  const { token, chat, semDestino } = destino();
  const leg = (TESTE ? '🧪 TESTE (só para você)\n' : '') + legenda;
  if (semDestino) { console.log('--- IMAGENS (teste; sem TELEGRAM_ALERTA_CHAT_ID, não enviadas): ' + pngs.join(', ') + ' ---\nlegenda: ' + leg); return; }
  if (!token || !chat) throw new Error('faltam os segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
  const f = new FormData();
  f.append('chat_id', chat);
  let metodo;
  if (pngs.length === 1) {
    metodo = 'sendPhoto';
    f.append('caption', leg);
    f.append('photo', new Blob([fs.readFileSync(pngs[0])], { type: 'image/png' }), 'painel.png');
  } else {
    metodo = 'sendMediaGroup';
    f.append('media', JSON.stringify(pngs.map((p, i) => Object.assign({ type: 'photo', media: 'attach://f' + i }, i === 0 ? { caption: leg } : {}))));
    pngs.forEach((p, i) => f.append('f' + i, new Blob([fs.readFileSync(p)], { type: 'image/png' }), 'painel' + (i + 1) + '.png'));
  }
  const r = await fetch(API_TG + '/bot' + token + '/' + metodo, { method: 'POST', body: f, signal: AbortSignal.timeout(120000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram recusou (' + metodo + '): ' + (j.description || 'HTTP ' + r.status));
  console.log((pngs.length > 1 ? 'álbum com ' + pngs.length + ' imagens' : 'foto') + ' enviado ao Telegram' + (TESTE ? ' (conversa privada, teste).' : '.'));
}

/* ---------- principal ---------- */
const estado = lerJson(ARQ + '.json', {});
const salvar = (id, valor) => {
  if (TESTE) return;
  const base = estado.data === HOJE ? JSON.parse(JSON.stringify(estado)) : { data: HOJE };
  if (MODO === 'medo') base.slots = Object.assign(base.slots || {}, { [id]: valor }); else base.lotes = Object.assign(base.lotes || {}, { [id]: valor });
  base.data = HOJE;
  gravar(ARQ + '.json', base);
};

try {
  if (MODO === 'medo') {
    const horarios = String(process.env.MEDO_HORARIOS || '08:00,21:30').split(',').map((x) => x.trim()).filter(Boolean);
    const ed = (TESTE || FORCAR) ? { id: 'teste', hm: HHMM, ultima: true } : edicao(horarios);
    if (!ed) sair('medo e ganância: edições às ' + horarios.join(' e ') + ' (agora ' + HHMM + '); nada a fazer.');
    if (!TESTE && !FORCAR && estado.data === HOJE && estado.slots && estado.slots[ed.id]) sair('medo e ganância: a edição das ' + hmBonito(ed.hm) + ' já foi enviada.');
    try {
      const spec = await dadosMedo();
      const png = desenhar(spec, 'medo');
      const h = spec.hist;
      const linhas = h.map((x) => x.rot + ': ' + x.valor + ' (' + x.classe + ')').join('\n');
      await enviar([png], '😱😄 ÍNDICE DE MEDO E GANÂNCIA DAS CRIPTOMOEDAS\n' + linhas + '\n\nQuanto mais perto de 0, mais medo no mercado; quanto mais perto de 100, mais ganância. Fonte: alternative.me.\n\n' + RODAPE + ASSINATURA);
      salvar(ed.id, true);
      fim('medo e ganância das ' + hmBonito(ed.hm) + ' enviado (' + spec.valor + ', ' + spec.classe + ')');
    } catch (e) {
      diag.erro = e.message;
      fim('medo e ganância não saiu: ' + e.message + (ed.ultima ? '' : ' (nova tentativa em 20 minutos)'), ed.ultima && !TESTE && !FORCAR);
    }
  } else {
    const horarios = String(process.env.FUTUROS_LOTES || '11:30,14:30,16:30').split(',').map((x) => x.trim()).filter(Boolean);
    const ed = (TESTE || FORCAR) ? (edicao(horarios) || { id: 'avulso', hm: HHMM, ultima: true }) : edicao(horarios);
    if (!TESTE && !FORCAR) {
      if (DOW === 0 || DOW === 6) sair('painel: fim de semana, a bolsa não abre.');
      if (!ed) sair('painel: lotes às ' + horarios.join(', ') + ' (agora ' + HHMM + '); nada a fazer.');
      if (estado.data === HOJE && estado.lotes && estado.lotes[ed.id] && estado.lotes[ed.id].enviado) sair('painel: o lote das ' + hmBonito(ed.hm) + ' já foi enviado.');
      if (!(await pregaoAberto())) { fim('provável feriado ou sem pregão hoje (cotações iguais ao fechamento de ontem); nada enviado'); process.exit(0); }
    }
    const pngs = [], itens = [], falhas = [];
    for (const [nome, fn] of [['setores', dadosSetores], ['cripto', dadosCripto], ['commodities', dadosCommodities], ['dolar', dadosDolar]]) {
      try { pngs.push(desenhar(await fn(), nome)); itens.push(nome); }
      catch (e) { console.warn('aviso ' + nome + ':', e.message); falhas.push(nome); diag['erro_' + nome] = e.message; }
    }
    diag.itens = itens; diag.falhas = falhas;
    if (falhas.length && !ed.ultima && !TESTE && !FORCAR) { fim('faltou ' + falhas.join(', ') + ': aguardando a nova tentativa (20 minutos) para enviar o painel completo'); process.exit(0); }
    if (!pngs.length) { fim('nenhuma imagem pôde ser montada (' + falhas.join(', ') + ')', !TESTE && !FORCAR); process.exit(process.exitCode || 0); }
    await enviar(pngs, '🌎 PAINEL DO MERCADO · ' + hmBonito(ed.hm) + '\nSetores da B3, criptomoedas, commodities e dólar no mundo, num só lugar. Cotações com atraso de alguns minutos, de fontes de terceiros.\n\n' + RODAPE + ASSINATURA);
    salvar(ed.id, { enviado: true, itens, falhas });
    fim('painel das ' + hmBonito(ed.hm) + ' enviado (' + itens.join(', ') + ')' + (falhas.length ? '; sem: ' + falhas.join(', ') : ''));
  }
} catch (e) {
  fim(e.message, true);
}
