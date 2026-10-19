/* Aviso diário do Plano B no Telegram.
   Roda no GitHub Actions (.github/workflows/telegram.yml) depois de `node gerar-dados.mjs bolsa-hoje`
   e `node gerar-dados.mjs proventos`. Horários (Brasília), cada parte sai só quando o dado está disponível
   e, se perdeu o horário, sai na próxima tentativa:
     a partir das 19h:  1) Maiores altas e 2) Maiores baixas (ações, FIIs de tijolo, FIIs de papel, ETFs)
                        3) Mercado: dólar e cripto (5 maiores altas e 5 maiores baixas do top 50)
     a partir das 20h:  4) Proventos (FIIs e ações anunciados), só se PROVENTOS_ENVIAR=1
     a partir das 21h:  5) Atualizações da B3 (mudanças de código, novos listados, possíveis retiradas), só se houver
   Variáveis (segredos do repositório):
     TELEGRAM_BOT_TOKEN   token do bot criado no @BotFather
     TELEGRAM_CHAT_ID     id do canal (começa com -100...) ou @nomedocanal
   Opcionais:
     TESTE=1             só mostra as mensagens no log, não envia e não grava o estado (ignora os horários)
     FORCAR=1            envia de novo as mensagens do dia (ignora o que já foi enviado hoje e os horários)
     PROVENTOS_ENVIAR=1  liga o envio dos proventos (em TESTE sempre aparece no log)
   Estado: saida/telegram.json guarda o que já foi enviado, para não repetir. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gravarMateriasFii } from './materias-fii.mjs';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.join(RAIZ, 'saida');
const TESTE = process.env.TESTE === '1';
const FORCAR = process.env.FORCAR === '1';
const ENVIAR_PROV = process.env.PROVENTOS_ENVIAR === '1';
const API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const AWESOME = process.env.AWESOME_URL || 'https://economia.awesomeapi.com.br/json/last/USD-BRL';
const GECKO = process.env.COINGECKO_URL || 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl,usd&include_24hr_change=true';
const GECKO_MKT = process.env.COINGECKO_MARKETS_URL || 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=brl&order=market_cap_desc&per_page=50&page=1&price_change_percentage=24h';
const SITE = 'https://planobinvestimentos.com/cotacoes/bolsa/';
const UA = { 'User-Agent': 'PlanoB-Investimentos-aviso/1.0 (uso educacional)' };

const lerJson = (arq) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, arq), 'utf8')); } catch (e) { return null; } };
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const pegar = async (url) => {
  const r = await fetch(url, { headers: Object.assign({ Accept: 'application/json' }, UA), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};
const pegarComRetry = async (url) => { try { return await pegar(url); } catch (e) { await dorme(3000); return pegar(url); } };

/* ---------- formatação em português ---------- */
const num = (v, c = 2) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });
const pct = (v) => (v >= 0 ? '+' : '−') + num(Math.abs(v)) + '%';
const brl = (v, c = 2) => 'R$ ' + num(v, c);
const brlAuto = (v) => brl(v, v >= 1000 ? 0 : v >= 1 ? 2 : v >= 0.01 ? 4 : 6);
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const dataBR = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

/* hoje em Brasília (UTC-3, sem horário de verão) */
const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T15:00:00Z') : new Date(Date.now() - 3 * 3600 * 1000); // DATA_TESTE=AAAA-MM-DD só para testes
const HOJE = agora.toISOString().slice(0, 10);
const DOW = agora.getUTCDay();
const HORA = process.env.HORA_TESTE ? Number(process.env.HORA_TESTE) : agora.getUTCHours();
/* cada parte só sai a partir do seu horário; em teste ou forçado, sai a qualquer hora */
const liberado = (h) => TESTE || FORCAR || HORA >= h;
/* PARTE (vem do horário agendado): fechamento (20h), proventos (18h e 22h), eventos (22h); sem PARTE = tudo */
const PARTE = process.env.PARTE || 'tudo';
const faz = (p) => PARTE === 'tudo' || PARTE.split(',').includes(p);
const titulo = (t) => t + ' · ' + DIAS[DOW] + ', ' + dataBR(HOJE);
const RODAPE = 'Conteúdo educacional. Não é recomendação de investimento.';

/* ---------- mensagens da bolsa ---------- */
const linhaAtivo = (x, e) => e + ' ' + x.t + ': ' + brl(x.p) + ' (' + pct(x.v) + ')';
const secao = (nome, lista, e) => (lista && lista.length ? nome + '\n' + lista.map((x) => linhaAtivo(x, e)).join('\n') : '');
function msgBolsa(b, altas) {
  const k = altas ? 'altas' : 'quedas', e = altas ? '🟢' : '🔻';
  const cab = '🚪 FECHAMENTO (' + dataBR(b.data) + ')\n' + (altas ? '⬆️ Maiores altas' : '⬇️ Maiores baixas');
  const ibov = altas && b.ibov ? 'Ibovespa (via BOVA11): ' + pct(b.ibov.v) : '';
  const gs = [['🏢 AÇÕES', b.acoes], ['🏠 FIIs DE TIJOLO', b.fiisTijolo], ['📄 FIIs DE PAPEL', b.fiisPapel], ['📦 ETFs', b.etfs]]
    .map(([n, g]) => secao(n, g && g[k], e)).filter(Boolean);
  if (!gs.length) return '';
  return [cab, ibov, gs.join('\n\n'), altas ? '' : 'Ranking completo: ' + SITE, altas ? '' : RODAPE].filter(Boolean).join('\n\n');
}

/* ---------- dólar e criptomoedas ---------- */
/* dólar: 1) AwesomeAPI  2) dólar calculado pelo preço do Bitcoin (BRL ÷ USD)  3) open.er-api.com (atualiza 1x ao dia) */
async function dolar(btc) {
  try {
    const u = (await pegarComRetry(AWESOME)).USDBRL;
    const v = parseFloat(u.bid), p = parseFloat(u.pctChange);
    if (v > 0) return { v, p: isFinite(p) ? p : null };
  } catch (e) { console.warn('aviso dólar (AwesomeAPI):', e.message); }
  if (btc && btc.brl > 0 && btc.usd > 0) {
    const v = btc.brl / btc.usd;
    if (v > 2 && v < 20) { console.warn('aviso: dólar calculado pelo Bitcoin.'); return { v, p: null }; }
  }
  try {
    const j = await pegar(process.env.ER_URL || 'https://open.er-api.com/v6/latest/USD');
    const v = j && j.rates && j.rates.BRL;
    if (v > 0) { console.warn('aviso: dólar da open.er-api.'); return { v, p: null }; }
  } catch (e) { console.warn('aviso dólar (open.er-api):', e.message); }
  return null;
}
const FORA = new Set(['usdt', 'usdc', 'dai', 'usde', 'fdusd', 'usds', 'busd', 'tusd', 'pyusd', 'usdd', 'usdt0', 'susde', 'usd1', 'usdtb', 'bsc-usd', 'steth', 'wsteth', 'wbtc', 'weth', 'weeth', 'wbeth', 'cbbtc', 'reth', 'cbeth', 'susds', 'bfusd', 'ousg', 'buidl', 'wtrx', 'jitosol', 'rseth']);
/* top 50 por valor de mercado, sem stablecoins nem versões "embrulhadas": 5 maiores altas e 5 maiores baixas em 24h */
async function cripto(dol, btcSimples) {
  const vazio = { btc: btcSimples ? { s: 'BTC', p: btcSimples.brl, v: btcSimples.brl_24h_change } : null, altas: [], quedas: [] };
  try {
    const j = await pegarComRetry(GECKO_MKT);
    const chg = (c) => (c.price_change_percentage_24h_in_currency != null ? c.price_change_percentage_24h_in_currency : c.price_change_percentage_24h);
    const l = (Array.isArray(j) ? j : []).filter((c) => {
      const s = String(c.symbol || '').toLowerCase();
      if (FORA.has(s) || !(c.current_price > 0) || !isFinite(chg(c))) return false;
      return !(dol && c.current_price / dol > 0.97 && c.current_price / dol < 1.03 && Math.abs(chg(c)) < 1);   // parece stablecoin
    }).map((c) => ({ s: String(c.symbol).toUpperCase(), p: c.current_price, v: chg(c) }));
    const btc = l.find((x) => x.s === 'BTC') || vazio.btc;
    return { btc, altas: [...l].filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 5), quedas: [...l].filter((x) => x.v < 0).sort((a, b) => a.v - b.v).slice(0, 5) };
  } catch (e) { console.warn('aviso criptomoedas:', e.message); }
  return vazio;
}
async function blocoMercado() {
  let btc = null;
  try { const j = await pegarComRetry(GECKO); if (j.bitcoin && j.bitcoin.brl > 0) btc = j.bitcoin; } catch (e) { console.warn('aviso bitcoin:', e.message); }
  const d = await dolar(btc);
  const c = await cripto(d && d.v, btc);
  return { dolar: d, cripto: c };
}
function msgMercado(m, fimDeSemana, temBolsa) {
  const cab = fimDeSemana ? titulo('📊 Mercado no fim de semana') : titulo('📊 Mercado hoje');
  const intro = fimDeSemana ? 'A bolsa não abre hoje. Veja o dólar (último fechamento) e as criptomoedas:' : (temBolsa ? '' : 'Os números de ações, FIIs e ETFs saem assim que a B3 liberar o fechamento.');
  const d = m.dolar ? '💵 Dólar: ' + brl(m.dolar.v) + (m.dolar.p !== null ? ' (' + pct(m.dolar.p) + ')' : '') : '';
  const c = m.cripto;
  const lin = (x, e) => e + ' ' + x.s + ': ' + brlAuto(x.p) + ' (' + pct(x.v) + ')';
  const cr = [];
  if (c.btc) cr.push('₿ Bitcoin: ' + brlAuto(c.btc.p) + (isFinite(c.btc.v) ? ' (' + pct(c.btc.v) + ')' : ''));
  if (c.altas.length) cr.push('⬆️ Maiores altas em 24h (top 50)\n' + c.altas.map((x) => lin(x, '🟢')).join('\n'));
  if (c.quedas.length) cr.push('⬇️ Maiores baixas em 24h (top 50)\n' + c.quedas.map((x) => lin(x, '🔻')).join('\n'));
  const temCripto = cr.length > 0;
  return [cab, intro, d, temCripto ? '🪙 CRIPTO\n' + cr.join('\n\n') : '', temCripto ? 'Cripto: dados da CoinGecko.' : '', RODAPE].filter(Boolean).join('\n\n');
}

/* ---------- atualizações da B3 ---------- */
const NCLS = { FII: '🏠 FIIs', ETF: '📦 ETFs', 'Ação': '🏢 Ações' };
function msgEventos(ev) {
  const blocos = [];
  if (ev.codigo.length) blocos.push('Mudanças de código:\n' + ev.codigo.map((x) => '• ' + x.de + ' ⏩ ' + x.para).join('\n'));
  const porCls = (lista) => Object.keys(NCLS).map((c) => { const t = lista.filter((x) => x.cls === c).map((x) => x.t); return t.length ? NCLS[c] + ': ' + t.join(', ') : ''; }).filter(Boolean).join('\n');
  if (ev.novos.length) blocos.push('🆕 Novos listados:\n' + porCls(ev.novos));
  if (ev.sairam.length) blocos.push('⚠️ Sem negociação há mais de 30 dias (possível retirada da B3):\n' + porCls(ev.sairam));
  if (!blocos.length) return '';
  return ['🔄 ATUALIZAÇÕES NA B3 · ' + dataBR(ev.data), ...blocos, 'Fonte: arquivos de negociação da B3. Confirme nos comunicados oficiais.'].join('\n\n');
}

/* ---------- proventos ---------- */
function msgProventos(itens, data, precos = {}) {
  const dt = (br) => br || 'a definir';
  const curto = (br) => (br ? br.slice(0, 5) : 'a definir');
  const casas = (v) => (Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? 2 : Math.abs(v * 10000 - Math.round(v * 10000)) < 1e-6 ? 4 : 6);
  /* FII em linha compacta: HGLG11: R$ 1,17 (0,73%) · base 30/09 · pag. 15/10  (% = valor ÷ último fechamento) */
  const linhaFii = (x) => {
    const p = precos[x.t], dy = p > 0 && x.tipo !== 'Amortização' ? ' (' + num((x.v / p) * 100) + '%)' : '';
    return x.t + ': ' + brl(x.v, casas(x.v)) + dy + (x.tipo === 'Amortização' ? ' [amortização]' : '') + (x.extra ? ' 🔔' : '') + ' · base ' + curto(x.base) + ' · pag. ' + curto(x.pag);
  };
  const linhaAcao = (x) => x.t + ' — ' + x.tipo + ': ' + brl(x.v, casas(x.v)) + '\n   Data-com: ' + dt(x.base) + ' · Pagamento: ' + dt(x.pag);
  const f = itens.filter((x) => x.fonte === 'FII').sort((a, b) => a.t.localeCompare(b.t)), a = itens.filter((x) => x.fonte !== 'FII').sort((x, y) => x.t.localeCompare(y.t));
  const corpo = [f.length ? '🏠 FIIs\n' + f.map(linhaFii).join('\n') : '', a.length ? '🏢 AÇÕES\n' + a.map(linhaAcao).join('\n') : ''].filter(Boolean).join('\n\n');
  if (!corpo) return '';
  const notas = [];
  if (f.length) notas.push('FIIs: valor por cota; entre parênteses, o valor em relação ao último fechamento (rendimento de um mês, não garante os próximos). Só FIIs com negociação média acima de R$ 1 milhão por dia.' + (f.some((x) => x.extra) ? ' 🔔 = pagamento fora do padrão habitual do fundo.' : ''));
  if (a.length) notas.push('Ações: valor bruto por ação. JCP tem imposto retido na fonte.');
  return ['💰 PROVENTOS ANUNCIADOS · ' + dataBR(data), corpo, notas.join('\n'), 'Fonte: B3. Confira sempre o comunicado oficial.', RODAPE].filter(Boolean).join('\n\n');
}

/* ---------- envio ---------- */
function partir(texto, max = 3900) {
  if (texto.length <= max) return [texto];
  const out = []; let atual = '';
  for (const bloco of texto.split('\n\n')) {
    if ((atual + '\n\n' + bloco).length > max && atual) { out.push(atual); atual = bloco; }
    else atual = atual ? atual + '\n\n' + bloco : bloco;
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
    const r = await fetch(API + '/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: parte, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error('Telegram recusou: ' + (j.description || 'HTTP ' + r.status));
    console.log('enviado ao Telegram.');
    await dorme(1200);
  }
}

/* ---------- decide o que enviar ---------- */
const anterior = lerJson('telegram.json') || {};
const E = anterior.data === HOJE && !FORCAR ? Object.assign({}, anterior.enviado || {}) : {};
let provIds = anterior.provIds;
const salvar = () => { if (!TESTE) fs.writeFileSync(path.join(SAIDA, 'telegram.json'), JSON.stringify({ data: HOJE, enviado: E, provIds })); };

const bolsa = lerJson('bolsa.json');
const temBolsa = !!(bolsa && bolsa.data === HOJE && bolsa.acoes);
const fimDeSemana = DOW === 0 || DOW === 6;

try {
  /* 1 e 2: altas e baixas */
  if (faz('fechamento') && liberado(20) && !fimDeSemana && temBolsa && !E.fech) {
    const a = msgBolsa(bolsa, true), b = msgBolsa(bolsa, false);
    if (a) await enviar(a);
    if (b) await enviar(b);
    E.fech = true; salvar();
  }
  /* 3: dólar e cripto */
  if (faz('fechamento') && liberado(20) && !E.merc) {
    const m = await blocoMercado();
    if (m.dolar || m.cripto.btc || m.cripto.altas.length) { await enviar(msgMercado(m, fimDeSemana, temBolsa)); E.merc = true; salvar(); }
    else console.warn('aviso: sem dados de dólar e criptomoedas; nada enviado.');
  }
  /* 4: atualizações da B3 (só depois que o arquivo do dia da B3 saiu) */
  if (faz('eventos') && liberado(22) && !fimDeSemana && temBolsa && !E.ev) {
    const ev = lerJson('eventos.json');
    if (ev && ev.data === HOJE) {
      const t = ev.base ? '' : msgEventos(ev);
      if (t) await enviar(t); else console.log('sem novidades de códigos na B3 hoje.');
      E.ev = true; salvar();
    } else console.log('eventos da B3 de hoje ainda não disponíveis.');
  }
  /* 5: proventos (cada provento é enviado uma única vez) */
  const prov = lerJson('proventos.json');
  if (prov && faz('proventos') && liberado(18) && (ENVIAR_PROV || TESTE)) {
    const chave = (x) => [x.t, x.tipo, x.base, x.pag, x.v].join('|');
    const vistos = new Set(provIds || []);
    const liqFii = (lerJson('liquidez-fiis.json') || {}).fiis || {};   // regra: só FIIs com liquidez acima de R$ 1 milhão/dia
    let novos = (prov.fii || []).filter((x) => liqFii[x.t]).map((x) => Object.assign({ fonte: 'FII' }, x)).concat((prov.acoes || []).map((x) => Object.assign({ fonte: 'AÇÃO' }, x)));
    if (!TESTE) { novos = novos.filter((x) => !vistos.has(chave(x))); if (!provIds) novos = novos.filter((x) => x.ent === HOJE); }
    const d1 = lerJson('d1.json');
    const precos = (d1 && d1.p) || {};
    const t = msgProventos(novos, HOJE, precos);
    if (t) {
      await enviar(t);
      if (!TESTE) {
        provIds = [...vistos, ...novos.map(chave)].slice(-3000); salvar();
        try { const n = gravarMateriasFii(novos.filter((x) => x.fonte === 'FII'), { saida: SAIDA, precos, dataPreco: d1 && d1.data, hoje: HOJE }); if (n) console.log('matérias de rendimento extraordinário no site:', n); }
        catch (e) { console.warn('aviso: não consegui gravar matérias de FIIs:', e.message); }
      } else {
        const ex = novos.filter((x) => x.fonte === 'FII' && x.extra);
        console.log('(teste) rendimentos extraordinários que virariam matéria no site:', ex.length ? ex.map((x) => x.t + ' (' + x.extra + ')').join('; ') : 'nenhum');
      }
    }
    else console.log('sem proventos novos para enviar.');
  } else if (prov && faz('proventos') && liberado(18)) console.log('proventos: envio desligado (PROVENTOS_ENVIAR); nada enviado.');
} catch (e) {
  console.error('ERRO:', e.message);
  process.exitCode = 1;
}
