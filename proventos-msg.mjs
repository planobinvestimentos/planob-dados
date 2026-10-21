/* Mensagens de proventos e envio ao Telegram, usados por telegram.mjs (resumo e releitura da noite) e proventos-agora.mjs (aviso na hora).
   - msgProventos: mensagem de proventos anunciados (FIIs em linha compacta, ETFs em destaque, ações, JCP, bonificação)
   - msgResumo:    resumo do dia (tudo o que foi anunciado hoje, em uma lista só)
   - enviarTexto / enviarPdf: envio ao Telegram (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID; TESTE=1 só mostra no log) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const RODAPE = 'Conteúdo educacional. Não é recomendação de investimento.';
export const ASSINATURA = '\n\n📲 Participe do nosso grupo do Telegram: @planobinvestimentos';

export const num = (v, c = 2) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });
export const brl = (v, c = 2) => 'R$ ' + num(v, c);
export const dataBR = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
const casas = (v) => (Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? 2 : Math.abs(v * 10000 - Math.round(v * 10000)) < 1e-6 ? 4 : 6);
const dt = (br) => br || 'a definir';
const curto = (br) => (br ? br.slice(0, 5) : 'a definir');
const ehBonif = (x) => x.tipo === 'Bonificação';

/* ---------- ficha do FII: tipo (tijolo/papel), P/VP e cotistas ----------
   Tipo: das listas do Plano B (listas-bolsa.json); fundo fora das listas mostra o segmento informado à CVM.
   O resto (valor patrimonial, P/VP e cotistas) vem de saida/fii-info.json (workflow "Liquidez dos FIIs", script fii-info.mjs). Se o arquivo ou o dado faltar, a linha simplesmente não aparece. */
const DIR_MSG = path.dirname(fileURLToPath(import.meta.url));
let _fichas = null;
function fontes() {
  if (_fichas) return _fichas;
  _fichas = { info: {}, tijolo: new Set(), papel: new Set() };
  try { _fichas.info = JSON.parse(fs.readFileSync(path.join(process.env.SAIDA_DIR || path.join(DIR_MSG, 'saida'), 'fii-info.json'), 'utf8')).itens || {}; } catch (e) { /* sem ficha */ }
  try {
    const l = JSON.parse(fs.readFileSync(path.join(DIR_MSG, 'listas-bolsa.json'), 'utf8')), conj = (a) => new Set((a || []).map((t) => String(t).trim().toUpperCase()));
    _fichas.tijolo = conj(l.fiisTijolo); _fichas.papel = conj(l.fiisPapel);
  } catch (e) { /* sem listas */ }
  return _fichas;
}
const TVM = /t[ií]tulos e valores mobili/i;
function ficha(tk, preco) {
  const F = fontes(), i = F.info[tk] || {};
  let tipo = '';
  if (F.tijolo.has(tk)) tipo = 'Tijolo' + (i.seg && !TVM.test(i.seg) && !/^tijolo$/i.test(i.seg) ? ' (' + i.seg + ')' : '');
  else if (F.papel.has(tk)) tipo = 'Papel';
  else if (i.seg) tipo = TVM.test(i.seg) ? 'Títulos e valores mobiliários (papel ou fundo de fundos)' : i.seg;
  const pvp = preco > 0 && i.vp > 0 && preco / i.vp >= 0.1 && preco / i.vp <= 5 ? preco / i.vp : null;
  return { tipo, curto: F.tijolo.has(tk) ? 'tijolo' : F.papel.has(tk) ? 'papel' : '', pvp, vp: pvp !== null ? i.vp : null, ref: i.ref ? i.ref.slice(5, 7) + '/' + i.ref.slice(0, 4) : '', cotistas: i.cotistas };
}

/* chave que identifica um provento (para não enviar duas vezes) */
export const chaveProvento = (x) => [x.t, x.tipo, x.base, x.pag, x.v].join('|');
/* chave "alternativa" (mesmo fundo/ação, mesma data de pagamento e mesmo valor): pega o mesmo provento vindo de duas fontes (B3 e aviso do FNET) com pequenas diferenças de escrita */
export const chaveAlt = (x) => ['ALT', x.t, x.pag, x.v].join('|');
/* sinais nas linhas: ✏️ valor corrigido em relação ao anúncio anterior; 🆕 (só no resumo) = ainda não tinha saído durante o dia */
const sufixo = (x) => (x.atualizado !== undefined ? ' ✏️ corrigido (antes ' + brl(x.atualizado, casas(x.atualizado)) + ')' : '') + (x.novoNoResumo ? ' 🆕' : '');

/* IR sobre o rendimento: FII = isento para pessoa física (regra geral); ETF = 15% retido na fonte (conferido com o QQQI11: 1,11% bruto → 0,94% líquido) */
const IR_ETF = 0.15;
const pctCota = (x, precos) => { const p = precos[x.t]; return p > 0 && x.tipo !== 'Amortização' ? (x.v / p) * 100 : null; };

/* FII/ETF em bloco (um por provento), na ordem pedida pelo Andrade: Código, Valor da cota, Dividendos, Data de pagamento, % sobre o preço, % líquida */
function blocoFii(x, precos) {
  const etf = x.cls === 'ETF', amort = x.tipo === 'Amortização', p = precos[x.t], bruto = pctCota(x, precos);
  const fc = etf ? null : ficha(x.t, p);
  const l = [(etf ? '📦' : '🏠') + ' Código: ' + x.t + (x.novoNoResumo ? ' 🆕' : '')];
  if (fc && fc.tipo) l.push('🧱 Tipo: ' + fc.tipo);
  if (p > 0) l.push('🏷️ Valor da cota (último fechamento): ' + brl(p));
  if (fc && fc.pvp !== null) l.push('📐 P/VP: ' + num(fc.pvp) + ' (valor patrimonial de ' + brl(fc.vp) + ' por cota)');
  l.push('💰 ' + (amort ? 'Amortização' : 'Dividendos') + ': ' + brl(x.v, casas(x.v)) + (x.extra ? ' 🔔' : ''));
  l.push('💸 Data de pagamento: ' + dt(x.pag));
  if (bruto !== null) {
    l.push('📊 % sobre o preço: ' + num(bruto) + '%');
    l.push('ℹ️ % líquida: ' + num(etf ? bruto * (1 - IR_ETF) : bruto) + '%' + (etf ? ' (após 15% de IR)' : ' (isento de IR para pessoa física)'));
  }
  if (fc) {
    if (fc.cotistas > 0) l.push('👥 Cotistas: ' + fc.cotistas.toLocaleString('pt-BR'));
  }
  if (x.extra) l.push('🔔 Pagamento fora do padrão habitual do fundo');
  if (x.atualizado !== undefined) l.push('✏️ Corrigido (antes ' + brl(x.atualizado, casas(x.atualizado)) + ')');
  return l.join('\n');
}
/* versão curta, só para o resumo do dia (lista com muitos fundos): HGLG11: R$ 1,17 · 0,73% sobre a cota · base 30/09 · pag. 15/10 */
function linhaFii(x, precos) {
  const b = pctCota(x, precos);
  const fc = x.cls === 'ETF' ? null : ficha(x.t, precos[x.t]);
  return x.t + (fc && fc.curto ? ' (' + fc.curto + ')' : '') + ': ' + brl(x.v, casas(x.v)) + (b !== null ? ' · ' + num(b) + '% sobre a cota' : '') + (fc && fc.pvp !== null ? ' · P/VP ' + num(fc.pvp) : '') + (x.tipo === 'Amortização' ? ' [amortização]' : '') + (x.extra ? ' 🔔' : '') + ' · base ' + curto(x.base) + ' · pag. ' + curto(x.pag) + sufixo(x);
}
const linhaAcao = (x) => ehBonif(x)
  ? x.t + ' — Bonificação de ' + num(x.v, 2) + '% em ações' + sufixo(x) + '\n   Data-com: ' + dt(x.base) + (x.pag ? ' · Pagamento: ' + x.pag : '')
  : x.t + ' — ' + x.tipo + ': ' + brl(x.v, casas(x.v)) + sufixo(x) + '\n   Data-com: ' + dt(x.base) + ' · Pagamento: ' + dt(x.pag);
const linhaAcaoCurta = (x) => ehBonif(x)
  ? x.t + ': ' + num(x.v, 2) + '% em ações · data-com ' + curto(x.base) + sufixo(x)
  : x.t + ': ' + brl(x.v, casas(x.v)) + ' · data-com ' + curto(x.base) + ' · pag. ' + curto(x.pag) + sufixo(x);

const grupos = (itens) => ({
  f: itens.filter((x) => x.fonte === 'FII' && x.cls !== 'ETF').sort((a, b) => a.t.localeCompare(b.t)),
  et: itens.filter((x) => x.fonte === 'FII' && x.cls === 'ETF').sort((a, b) => a.t.localeCompare(b.t)),
  a: itens.filter((x) => x.fonte !== 'FII').sort((a, b) => a.t.localeCompare(b.t)),
});
const notas = (g, itensTodos = [], resumo = false) => {
  const n = [];
  if (!resumo && g.f.some((x) => fontes().info[x.t])) {
    const ref = (g.f.map((x) => ficha(x.t, 0).ref).filter(Boolean).sort().pop()) || '';
    n.push('FIIs: P/VP = preço da cota ÷ valor patrimonial por cota. O valor patrimonial e o número de cotistas vêm do último informe mensal do fundo à CVM' + (ref ? ' (ref. ' + ref + ')' : '') + ', com 1 a 2 meses de defasagem.');
  }
  if (resumo && g.f.some((x) => x.extra)) n.push('🔔 = pagamento fora do padrão habitual do fundo.');
  if (resumo && itensTodos.some((x) => x.atualizado !== undefined)) n.push('✏️ = a empresa ou o fundo corrigiu o valor em relação ao anúncio anterior (não é um provento repetido).');
  if (!resumo && g.a.some((x) => x.atualizado !== undefined)) n.push('✏️ = a empresa corrigiu o valor em relação ao anúncio anterior (não é um provento repetido).');
  if (g.a.length) n.push('Ações: valor bruto por ação. JCP tem imposto retido na fonte.' + (g.a.some(ehBonif) ? ' Bonificação: o percentual é a quantidade de ações novas para cada 100 que você tem.' : ''));
  return n.join('\n');
};

export function msgProventos(itens, data, precos = {}, titulo = '💰 PROVENTOS ANUNCIADOS') {
  const g = grupos(itens);
  const corpo = [...g.f.map((x) => blocoFii(x, precos)), ...g.et.map((x) => blocoFii(x, precos)), g.a.length ? '🏢 AÇÕES\n' + g.a.map(linhaAcao).join('\n') : ''].filter(Boolean).join('\n\n');
  if (!corpo) return '';
  return [titulo + ' · ' + dataBR(data), corpo, notas(g, itens, false), 'Fonte: B3. Confira sempre o comunicado oficial.', RODAPE].filter(Boolean).join('\n\n');
}

/* resumo do dia: tudo o que foi anunciado hoje, separado por tipo, em linhas curtas */
export function msgResumo(itens, data, precos = {}) {
  const g = grupos(itens);
  const div = g.a.filter((x) => x.tipo === 'Dividendo'), jcp = g.a.filter((x) => x.tipo === 'JCP'), bon = g.a.filter(ehBonif), outros = g.a.filter((x) => x.tipo !== 'Dividendo' && x.tipo !== 'JCP' && !ehBonif(x));
  const blocos = [
    g.f.length ? '🏠 FIIs (' + g.f.length + ')\n' + g.f.map((x) => linhaFii(x, precos)).join('\n') : '',
    g.et.length ? '📦 ETFs em destaque\n' + g.et.map((x) => linhaFii(x, precos)).join('\n') : '',
    div.length ? '💵 DIVIDENDOS (ações)\n' + div.map(linhaAcaoCurta).join('\n') : '',
    jcp.length ? '💼 JCP (ações)\n' + jcp.map(linhaAcaoCurta).join('\n') : '',
    bon.length ? '🎁 BONIFICAÇÃO\n' + bon.map(linhaAcaoCurta).join('\n') : '',
    outros.length ? '🏢 OUTROS PROVENTOS (ações)\n' + outros.map(linhaAcaoCurta).join('\n') : '',
  ].filter(Boolean);
  if (!blocos.length) return '';
  const total = itens.length;
  return ['📋 RESUMO DO DIA · ' + dataBR(data), 'Dividendos, JCP e bonificações anunciados hoje (' + total + ' no total).\n🔁 Repetição proposital: quase tudo aqui já saiu ao longo do dia. Esta é a lista única do dia, para você consultar de uma vez.' + (itens.some((x) => x.novoNoResumo) ? '\n🆕 = ainda não tinha saído durante o dia.' : ''), blocos.join('\n\n'), notas(g, itens, true), 'Fonte: B3. Confira sempre o comunicado oficial.', RODAPE].filter(Boolean).join('\n\n');
}

/* ---------- envio ---------- */
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
export function partir(texto, max = 3900) {
  if (texto.length <= max) return [texto];
  const out = []; let atual = '';
  for (const bloco of texto.split('\n\n')) {
    if ((atual + '\n\n' + bloco).length > max && atual) { out.push(atual); atual = bloco; }
    else atual = atual ? atual + '\n\n' + bloco : bloco;
  }
  if (atual) out.push(atual);
  return out.flatMap((p) => (p.length <= max ? [p] : p.match(new RegExp('[\\s\\S]{1,' + max + '}', 'g'))));
}
const credenciais = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('faltam os segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
  return { token, chat };
};
const api = () => process.env.TELEGRAM_API || 'https://api.telegram.org';

export async function enviarTexto(texto, { teste = false } = {}) {
  for (const corpo of partir(texto)) {
    const parte = corpo + ASSINATURA;
    if (teste) { console.log('--- MENSAGEM (teste, não enviada) ---\n' + parte + '\n--- fim ---'); continue; }
    const { token, chat } = credenciais();
    const r = await fetch(api() + '/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: parte, disable_web_page_preview: true }), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error('Telegram recusou: ' + (j.description || 'HTTP ' + r.status));
    console.log('enviado ao Telegram.');
    await dorme(1200);
  }
}

/* PDF como documento (limite do Telegram para bots: 50 MB; aqui 25 MB por segurança) */
export async function enviarPdf(buf, nomeArquivo, legenda, { teste = false } = {}) {
  if (buf.length > 25 * 1024 * 1024) throw new Error('PDF grande demais (' + Math.round(buf.length / 1048576) + ' MB)');
  if (teste) { console.log('--- PDF (teste, não enviado) --- ' + nomeArquivo + ' · ' + Math.round(buf.length / 1024) + ' KB · legenda: ' + legenda); return; }
  const { token, chat } = credenciais();
  const fd = new FormData();
  fd.append('chat_id', chat);
  fd.append('caption', (legenda + '\n\n@planobinvestimentos').slice(0, 1000));
  fd.append('document', new Blob([buf], { type: 'application/pdf' }), nomeArquivo);
  const r = await fetch(api() + '/bot' + token + '/sendDocument', { method: 'POST', body: fd, signal: AbortSignal.timeout(90000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram recusou o PDF: ' + (j.description || 'HTTP ' + r.status));
  console.log('PDF enviado ao Telegram:', nomeArquivo);
  await dorme(1200);
}
