/* PIZZA DO PLANO B no Telegram: placar de 4 fatias (Ibovespa, Bitcoin, S&P 500 e CDI), valorização desde 1º de janeiro do ano, tudo em reais.
   Roda no GitHub Actions (pizza.yml). SÓ USA NÚMEROS REAIS, buscados na hora: nada é digitado à mão. Se qualquer fonte falhar, estiver velha ou der um valor absurdo,
   NÃO posta no canal: avisa no seu Telegram privado (TELEGRAM_ALERTA_CHAT_ID) e termina em ❌.
   Quando sai:
     dia     segunda a sexta, a partir das 19h40 (Brasília): variação "no dia"; só em dia de pregão da B3.
     sabado  sábado, a partir das 12h: variação "na semana" (Ibovespa, S&P 500 e CDI no fechamento de sexta; Bitcoin ao vivo).
   Fontes: Yahoo Finance (^BVSP, ^GSPC, BTC-USD, BRL=X), reserva Stooq; CDI: Banco Central (série 12). A base do ano é o último fechamento do ano anterior
   e muda sozinha a cada 1º de janeiro. "Dias na liderança" é recalculado a cada execução a partir das séries (não depende de arquivo salvo).
   Variáveis: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ALERTA_CHAT_ID. Opcionais: TESTE=1 (monta o cartão e manda SÓ para o seu privado, não grava estado),
   FORCAR=1 (ignora horário e "já enviou hoje"), MODO=dia|sabado, DATA_TESTE/HORA_TESTE (simular), YAHOO_URL, STOOQ_URL, BCB_URL, TELEGRAM_API. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = process.env.SAIDA_DIR || path.join(RAIZ, 'saida');
const TESTE = process.env.TESTE === '1', FORCAR = process.env.FORCAR === '1';
const YAHOO = process.env.YAHOO_URL || 'https://query1.finance.yahoo.com';
const YAHOO2 = process.env.YAHOO_URL || 'https://query2.finance.yahoo.com';
const STOOQ = process.env.STOOQ_URL || 'https://stooq.com';
const BCB = process.env.BCB_URL || 'https://api.bcb.gov.br';
const TG = process.env.TELEGRAM_API || 'https://api.telegram.org';

/* agora em Brasília (UTC-3) */
const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T' + String(process.env.HORA_TESTE || '19').padStart(2, '0') + ':' + String(process.env.MINUTO_TESTE || '45').padStart(2, '0') + ':00Z') : new Date(Date.now() - 3 * 3600 * 1000);
const HOJE = agora.toISOString().slice(0, 10);
const DOW = agora.getUTCDay();
const MIN = agora.getUTCHours() * 60 + agora.getUTCMinutes();
const ANO = Number(HOJE.slice(0, 4));
const MODO = process.env.MODO || (DOW === 6 ? 'sabado' : 'dia');
const HORA_MIN = MODO === 'sabado' ? 12 * 60 : 19 * 60 + 40;
const NOMES = { ibov: 'Ibovespa', btc: 'Bitcoin', spx: 'S&P 500', cdi: 'CDI' };
const avisos = [];
const fontesUsadas = new Set();

const lerJson = (arq, pad = null) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, arq), 'utf8')); } catch (e) { return pad; } };
const gravar = (arq, obj) => { fs.mkdirSync(SAIDA, { recursive: true }); fs.writeFileSync(path.join(SAIDA, arq), JSON.stringify(obj, null, 1)); };
const somaDias = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- formatação (pt-BR, sem depender do ICU do Node) ---------- */
const milhar = (n, casas = 0) => { const [i, d] = Math.abs(n).toFixed(casas).split('.'); return (n < 0 ? '−' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (d ? ',' + d : ''); };
const pct = (x, casas = 2) => (x >= 0 ? '+' : '−') + milhar(Math.abs(x), casas) + '%';
const dataBR = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
const esc = (s) => String(s).replace(/&/g, '&amp;');

/* ---------- buscas ---------- */
async function pegar(url, tipo = 'json', tentativas = 3) {
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlanoB-Pizza/1.0)', Accept: tipo === 'json' ? 'application/json' : 'text/csv,*/*' }, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      if (tipo === 'json') return JSON.parse(txt);
      return txt;
    } catch (e) { ultimo = e; await dormir(1500 * (i + 1)); }
  }
  throw ultimo;
}

const iso = (d) => d.toISOString().slice(0, 10);
const P1 = Date.parse((ANO - 1) + '-12-10T00:00:00Z') / 1000;
const P2 = Math.floor(Date.now() / 1000) + 2 * 86400;

/* Yahoo: devolve [{d:'AAAA-MM-DD', c:fechamento}] em ordem */
async function yahoo(simbolo) {
  let ultimo;
  for (const base of [YAHOO, YAHOO2]) {
    try {
      const j = await pegar(`${base}/v8/finance/chart/${encodeURIComponent(simbolo)}?period1=${P1}&period2=${P2}&interval=1d&events=history`, 'json', 2);
      const r = j.chart && j.chart.result && j.chart.result[0];
      if (!r || !r.timestamp) throw new Error('resposta sem dados');
      const off = (r.meta && r.meta.gmtoffset) || 0, q = r.indicators.quote[0].close;
      const out = [];
      r.timestamp.forEach((t, i) => { if (q[i] != null && q[i] > 0) out.push({ d: iso(new Date((t + off) * 1000)), c: q[i] }); });
      if (out.length < 5) throw new Error('poucos candles');
      fontesUsadas.add('Yahoo Finance');
      return out;
    } catch (e) { ultimo = e; }
  }
  throw new Error('Yahoo (' + simbolo + '): ' + ultimo.message);
}

/* Stooq (reserva): CSV Date,Open,High,Low,Close,Volume */
async function stooq(simbolo) {
  const d1 = (ANO - 1) + '1210', d2 = HOJE.replace(/-/g, '');
  const txt = await pegar(`${STOOQ}/q/d/l/?s=${encodeURIComponent(simbolo)}&i=d&d1=${d1}&d2=${d2}`, 'csv', 2);
  const out = [];
  for (const l of txt.trim().split(/\r?\n/).slice(1)) { const p = l.split(','); const c = Number(p[4]); if (/^\d{4}-\d\d-\d\d$/.test(p[0]) && c > 0) out.push({ d: p[0], c }); }
  if (out.length < 5) throw new Error('Stooq (' + simbolo + '): poucos dados');
  fontesUsadas.add('Stooq');
  return out;
}

async function comReserva(nome, simYahoo, simStooq) {
  try { return await yahoo(simYahoo); } catch (e) {
    avisos.push(nome + ': ' + e.message + ' → tentando Stooq');
    try { return await stooq(simStooq); } catch (e2) { throw new Error(nome + ': nenhuma fonte respondeu (' + e.message + '; ' + e2.message + ')'); }
  }
}

/* CDI diário (% ao dia) do Banco Central, série 12: devolve fator acumulado desde 1º de janeiro: [{d, c:fator, taxa:%dia}] */
async function cdi() {
  const br = (i) => i.slice(8) + '/' + i.slice(5, 7) + '/' + i.slice(0, 4);
  const j = await pegar(`${BCB}/dados/serie/bcdata.sgs.12/dados?formato=json&dataInicial=${br(ANO + '-01-01')}&dataFinal=${br(HOJE)}`, 'json', 4);
  if (!Array.isArray(j) || j.length < 3) throw new Error('CDI do Banco Central sem dados');
  let f = 1; const out = [];
  for (const x of j) {
    const m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(x.data); const v = Number(String(x.valor).replace(',', '.'));
    if (!m || !(v > 0 && v < 1)) throw new Error('CDI com valor estranho: ' + JSON.stringify(x));
    f *= 1 + v / 100; out.push({ d: `${m[3]}-${m[2]}-${m[1]}`, c: f, taxa: v });
  }
  fontesUsadas.add('Banco Central');
  return out;
}

/* ---------- utilitários de série ---------- */
const ate = (s, d) => { let r = null; for (const x of s) { if (x.d <= d) r = x; else break; } return r; };
const ultimo = (s) => s[s.length - 1];
const penultimo = (s) => s[s.length - 2];

async function alerta(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_ALERTA_CHAT_ID;
  if (!token || !chat || TESTE) { console.log('(aviso privado não enviado) ' + texto); return; }
  try {
    await fetch(`${TG}/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: texto.slice(0, 4000) }), signal: AbortSignal.timeout(30000) });
  } catch (e) { console.log('não consegui avisar no privado:', e.message); }
}

async function enviarFoto(chat, png, legenda, silencioso = true) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chat) throw new Error('faltam os segredos do Telegram (TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID)');
  const f = new FormData();
  f.append('chat_id', chat); f.append('caption', legenda.slice(0, 1024));
  if (silencioso) f.append('disable_notification', 'true');
  f.append('photo', new Blob([fs.readFileSync(png)], { type: 'image/png' }), 'pizza-plano-b.png');
  const r = await fetch(`${TG}/bot${token}/sendPhoto`, { method: 'POST', body: f, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram recusou a foto: ' + (j.description || 'HTTP ' + r.status));
}

/* ---------- principal ---------- */
try {
  if (DOW === 0 && !FORCAR && !process.env.MODO) { console.log('pizza: domingo, nada a fazer.'); process.exit(0); }
  const estado = lerJson('pizza.json', {});
  if (!TESTE && !FORCAR) {
    if (MIN < HORA_MIN) { console.log(`pizza (${MODO}): sai a partir das ${Math.floor(HORA_MIN / 60)}h${String(HORA_MIN % 60).padStart(2, '0')}; nada a fazer.`); process.exit(0); }
    if (estado[MODO] === HOJE) { console.log(`pizza (${MODO}): a de hoje (${HOJE}) já foi enviada.`); process.exit(0); }
  }

  const [ibov, spx, btc, usd, cd] = await Promise.all([
    comReserva('Ibovespa', '^BVSP', '^bvp'),
    comReserva('S&P 500', '^GSPC', '^spx'),
    comReserva('Bitcoin', 'BTC-USD', 'btcusd'),
    comReserva('Dólar', 'BRL=X', 'usdbrl'),
    cdi(),
  ]);

  /* frescor: o que precisa estar de hoje (ou do último dia útil, no sábado) */
  const ultimaSexta = (() => { let d = HOJE; if (MODO === 'sabado') d = somaDias(HOJE, -1); while (new Date(d + 'T12:00:00Z').getUTCDay() % 6 === 0) d = somaDias(d, -1); return d; })();
  if (MODO === 'dia' && ultimo(ibov).d !== HOJE) {
    console.log(`pizza: o Ibovespa não tem candle de hoje (${HOJE}; último ${ultimo(ibov).d}). Feriado ou dado atrasado.`);
    const feriado = !FORCAR && DOW >= 1 && DOW <= 5 && ultimo(ibov).d < HOJE;
    if (feriado) { avisos.push('Ibovespa sem candle de hoje: provável feriado'); if (MIN >= 21 * 60 + 30) await alerta(`⚠️ Pizza do Plano B: não saiu hoje (${dataBR(HOJE)}). O Ibovespa não tem fechamento de hoje na fonte (feriado ou atraso).`); process.exit(0); }
  }
  if (MODO === 'sabado' && ultimo(ibov).d < ultimaSexta) throw new Error(`Ibovespa desatualizado: último candle ${ultimo(ibov).d}, esperado ${ultimaSexta}`);
  if (ultimo(spx).d < somaDias(HOJE, -4)) throw new Error(`S&P 500 desatualizado: último candle ${ultimo(spx).d}`);
  if (ultimo(btc).d < somaDias(HOJE, -1)) throw new Error(`Bitcoin desatualizado: último candle ${ultimo(btc).d}`);
  if (ultimo(usd).d < somaDias(HOJE, -4)) throw new Error(`Dólar desatualizado: último candle ${ultimo(usd).d}`);
  if (ultimo(cd).d < somaDias(HOJE, -6)) throw new Error(`CDI desatualizado: último dado ${ultimo(cd).d}`);

  /* valor em reais de cada ativo numa data */
  const baseData = (ANO - 1) + '-12-31';
  const val = {
    ibov: (d) => { const x = ate(ibov, d); return x && x.c; },
    spx: (d) => { const a = ate(spx, d), b = ate(usd, d); return a && b && a.c * b.c; },
    btc: (d) => { const a = ate(btc, d), b = ate(usd, d); return a && b && a.c * b.c; },
    cdi: (d) => { const x = ate(cd, d); return x ? x.c : 1; },
  };
  const base = { ibov: val.ibov(baseData), spx: val.spx(baseData), btc: val.btc(baseData), cdi: 1 };
  for (const k of Object.keys(base)) if (!(base[k] > 0)) throw new Error('sem base de ' + (ANO - 1) + ' para ' + NOMES[k]);
  const ano = (k, d) => (val[k](d) / base[k] - 1) * 100;

  /* ranking de hoje */
  const total = {}; for (const k of Object.keys(NOMES)) total[k] = ano(k, HOJE);
  const ordem = Object.keys(total).sort((a, b) => total[b] - total[a]);
  const lider = ordem[0];

  /* tempo na liderança: dias de pregão (do Ibovespa) seguidos em que o líder de hoje já liderava */
  const datas = ibov.map((x) => x.d).filter((d) => d >= ANO + '-01-01' && d <= HOJE);
  const liderEm = (d) => Object.keys(NOMES).sort((a, b) => ano(b, d) - ano(a, d))[0];
  let dias = 0;
  for (let i = datas.length - 1; i >= 0; i--) { if (datas[i] === HOJE && i === datas.length - 1 && MODO === 'dia') { if (liderEm(HOJE) !== lider) break; dias++; continue; } if (liderEm(datas[i]) === lider) dias++; else break; }
  if (MODO === 'sabado') { dias = 0; for (let i = datas.length - 1; i >= 0; i--) { if (liderEm(datas[i]) === lider) dias++; else break; } }
  const NOME_UP = { ibov: 'IBOVESPA', btc: 'BITCOIN', spx: 'S&P 500', cdi: 'CDI' };
  let faixa;
  if (dias >= 2) faixa = `ESTAMOS HÁ ${dias} DIAS COM O ${NOME_UP[lider]} NA LIDERANÇA`;
  else if (datas.length > 1) faixa = `O ${NOME_UP[lider]} ASSUMIU A LIDERANÇA${MODO === 'dia' ? ' HOJE' : ''}`;
  else faixa = `O ${NOME_UP[lider]} ABRE O ANO NA LIDERANÇA`;

  /* variação do dia (ou da semana, no sábado) */
  const var_ = {};
  const anterior = (k) => { // valor de referência para "no dia"
    if (k === 'ibov') return penultimo(ibov).c;
    if (k === 'spx') { const p = penultimo(spx), u = ate(usd, p.d); return p.c * u.c; }
    if (k === 'btc') { const p = penultimo(btc), u = ate(usd, p.d); return p.c * u.c; }
    return null;
  };
  if (MODO === 'sabado') {
    const ref = somaDias(HOJE, -7);
    for (const k of Object.keys(NOMES)) { const a = val[k](ref); var_[k] = a > 0 ? (val[k](HOJE) / a - 1) * 100 : null; }
  } else {
    var_.ibov = (val.ibov(HOJE) / anterior('ibov') - 1) * 100;
    var_.spx = ultimo(spx).d === HOJE ? (val.spx(HOJE) / anterior('spx') - 1) * 100 : null;
    var_.btc = (val.btc(HOJE) / anterior('btc') - 1) * 100;
    var_.cdi = ultimo(cd).taxa;
  }

  /* textos de cada fatia */
  const taxaAno = (Math.pow(1 + ultimo(cd).taxa / 100, 252) - 1) * 100;
  const hojeTxt = {
    ibov: milhar(ultimo(ibov).c) + ' pts',
    spx: milhar(ultimo(spx).c) + ' pts',
    btc: 'R$ ' + milhar(val.btc(HOJE)),
    cdi: milhar(taxaAno, 2) + '% ao ano',
  };
  const ativos = {};
  ordem.forEach((k, i) => { ativos[k] = { rank: i + 1, total: pct(total[k]), hoje: hojeTxt[k], dia: var_[k] }; });

  /* sanidade: números absurdos = fonte quebrada, não posta */
  for (const k of Object.keys(NOMES)) {
    if (!isFinite(total[k]) || total[k] < -95 || total[k] > 1500) throw new Error(`valor absurdo para ${NOMES[k]}: ${total[k]}%`);
    if (var_[k] != null && (!isFinite(var_[k]) || Math.abs(var_[k]) > 40)) throw new Error(`variação absurda para ${NOMES[k]}: ${var_[k]}%`);
  }

  const hh = Math.floor(MIN / 60), mm = String(MIN % 60).padStart(2, '0');
  const dataCdi = dataBR(ultimo(cd).d).slice(0, 5);
  const fontes = ['B3 (Ibovespa)', 'S&P Dow Jones (S&P 500)', ...[...fontesUsadas].filter((x) => x !== 'Banco Central'), 'Banco Central'].join(', ').replace('B3 (Ibovespa), S&P Dow Jones (S&P 500), ', '');
  const dados = {
    modo: MODO, ano: String(ANO), lider, faixa: esc(faixa), ativos,
    quando: MODO === 'sabado' ? `SÁB ${dataBR(HOJE).slice(0, 5)}/${ANO} · ${hh}h${mm}` : `${dataBR(HOJE)} · ${hh}h${mm}`,
    rodape: `rentabilidade de 01/01/${ANO} até ${dataBR(HOJE)}, em reais, sem descontar impostos nem custos. S&amp;P 500 convertido pelo dólar; CDI até ${dataCdi}.` + (MODO === 'sabado' ? ' Ibovespa e S&amp;P 500 no fechamento de sexta.' : ''),
    fontes: [...fontesUsadas].join(', ') || 'Yahoo Finance, Banco Central',
  };

  fs.mkdirSync(SAIDA, { recursive: true });
  const jsonArq = path.join(SAIDA, 'pizza-dados.json'), png = path.join(SAIDA, 'pizza-cartao.png');
  fs.writeFileSync(jsonArq, JSON.stringify(dados, null, 1));
  execFileSync('python3', [path.join(RAIZ, 'pizza-arte.py'), jsonArq, png], { stdio: 'inherit', timeout: 120000 });

  const medalhas = ['🥇', '🥈', '🥉', '4️⃣'];
  const linhas = ordem.map((k, i) => `${medalhas[i]} ${NOMES[k]}: ${pct(total[k])} no ano`).join('\n');
  const legenda = [
    `🍕 Pizza do Plano B · ${MODO === 'sabado' ? 'resumo da semana · ' : ''}${dataBR(HOJE)}`,
    `Valorização de ${ANO} até o momento, em reais:`, '', linhas, '',
    `🌟 Elpis lembra: ${dados.rodape.replace(/&amp;/g, '&')} Os dados podem ter atraso. As fatias iguais são só para comparar: não é carteira recomendada nem recomendação de compra ou venda, e rentabilidade passada não garante ganho futuro. Fontes: ${dados.fontes}.`, '',
    '📲 Participe do nosso grupo do Telegram: @planobinvestimentos',
  ].join('\n');

  const diag = { hoje: HOJE, modo: MODO, hora: `${hh}:${mm}`, fontes: [...fontesUsadas], avisos, lider, dias_na_lideranca: dias, total, variacao: var_, ultimos: { ibov: ultimo(ibov), spx: ultimo(spx), btc: ultimo(btc), usd: ultimo(usd), cdi: ultimo(cd) }, bases: base };
  gravar('pizza-diag.json', diag);

  if (TESTE) {
    console.log('--- TESTE: legenda ---\n' + legenda + '\n--- diagnóstico ---\n' + JSON.stringify(diag, null, 1));
    const priv = process.env.TELEGRAM_ALERTA_CHAT_ID;
    if (priv && process.env.TELEGRAM_BOT_TOKEN) { await enviarFoto(priv, png, '🧪 TESTE (só para você)\n\n' + legenda, false); console.log('cartão de teste enviado ao seu Telegram privado.'); }
    else console.log('sem TELEGRAM_ALERTA_CHAT_ID: cartão salvo em ' + png + ' (não enviado).');
    process.exit(0);
  }
  await enviarFoto(process.env.TELEGRAM_CHAT_ID, png, legenda);
  estado[MODO] = HOJE; gravar('pizza.json', estado);
  console.log(`pizza (${MODO}) enviada: líder ${NOMES[lider]}, ${dias} dia(s); fontes: ${[...fontesUsadas].join(', ')}.`);
} catch (e) {
  console.error('ERRO:', e.message);
  gravar('pizza-diag.json', { hoje: HOJE, modo: MODO, erro: e.message, avisos });
  await alerta(`⚠️ Pizza do Plano B NÃO saiu (${MODO}, ${dataBR(HOJE)}): ${e.message}\n\nNada foi postado no canal. O robô tenta de novo nos próximos horários; se persistir, me chame.`);
  process.exitCode = 1;
}
