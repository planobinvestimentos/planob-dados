/* Fluxo de investidores na B3 no Telegram (segunda a sexta, 10h de Brasília): saldo diário do investidor estrangeiro e do institucional,
   últimos 10 pregões, saldo do mês e do ano, com gráfico.
   Fonte: tabela "Participação dos Investidores" do Boletim Diário (BDI) da B3, que traz o ACUMULADO DO MÊS (compras e vendas, em R$ mil) com
   2 pregões de atraso. O saldo de um dia é a diferença entre dois acumulados seguidos (saldo = compras − vendas).
   Roda no GitHub Actions (.github/workflows/fluxo.yml):  node fluxo.mjs
   Precisa: poppler-utils (pdftotext), python3 com matplotlib (gráfico; se faltar, sai só texto) e os segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID.
   Opcionais: TESTE=1, FORCAR=1, BDI_BASE, TELEGRAM_API, DATA_TESTE=AAAA-MM-DD, DIAS_BUSCA (padrão 16 pregões), SEM_GRAFICO=1.
   Diagnóstico: saida/fluxo-diag.json (se a leitura da tabela falhar, mostra o trecho do texto do PDF para ajuste). Histórico: saida/fluxo.json. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = process.env.SAIDA_DIR || path.join(AQUI, 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const TESTE = process.env.TESTE === '1', FORCAR = process.env.FORCAR === '1';
const API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const BDI_BASE = process.env.BDI_BASE || 'https://arquivos.b3.com.br/bdi/download/bdi/';
const DIAS_BUSCA = Number(process.env.DIAS_BUSCA) || 16;
const UA = { 'User-Agent': 'PlanoB-Investimentos-dados/1.0 (uso educacional)' };
const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T13:00:00Z') : new Date();
const br = new Date(agora.getTime() - 3 * 3600 * 1000);
const HOJE = br.toISOString().slice(0, 10), DOW = br.getUTCDay();
const diag = { gerado: new Date().toISOString(), baixados: 0, falhas: {}, lidos: 0 };
const lerJson = (n, pad) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, n), 'utf8')); } catch (e) { return pad; } };
const somaDias = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const util = (iso) => { const w = new Date(iso + 'T12:00:00Z').getUTCDay(); return w >= 1 && w <= 5; };
const dataBR = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const num1 = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/* v em R$ mil → "R$ 2,2 bilhões", "-R$ 2,5 bilhões", "R$ 370 milhões" */
function valor(vMil) {
  const s = vMil < 0 ? '-' : '';
  const a = Math.abs(vMil);
  if (a >= 1e6) return s + 'R$ ' + num1(a / 1e6) + ' bilhões';
  return s + 'R$ ' + Math.round(a / 1e3).toLocaleString('pt-BR') + ' milhões';
}
const bolinha = (v) => (v >= 0 ? '🟢' : '🔴');

/* ---------- leitura do PDF do BDI ---------- */
async function baixar(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  diag.baixados++;
  return Buffer.from(await r.arrayBuffer());
}
function textoDe(buf, de = 0, ate = 0) {
  if (buf.subarray(0, 4).toString() !== '%PDF') return buf.toString('utf8');   // (testes) texto puro
  const tmp = path.join(os.tmpdir(), 'bdi-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.pdf');
  fs.writeFileSync(tmp, buf);
  try { return execFileSync('pdftotext', ['-layout', ...(de ? ['-f', String(de), '-l', String(ate)] : []), tmp, '-'], { encoding: 'utf8', timeout: 120000, maxBuffer: 1e8 }); }
  finally { try { fs.unlinkSync(tmp); } catch (e) { /* ignora */ } }
}
const brNum = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));
const TIPOS = [['est', /estrangeir/i], ['inst', /institucion/i], ['fin', /institui[çc][õo]es? financeir|financeir/i], ['pf', /pessoas? f[ií]sica|individua/i], ['out', /^\s*outros/i]];
/* acha a tabela "Participação dos Investidores" (do mês até a data X) e devolve {ref, tipos:{est:[compras,vendas],...}} */
function lerTabela(texto, dataBdi) {
  const linhas = texto.split(/\r?\n/);
  for (let i = 0; i < linhas.length; i++) {
    if (!/participa[çc][ãa]o\s+dos\s+investidores/i.test(linhas[i]) || /mensal/i.test(linhas[i])) continue;
    const janela = linhas.slice(i, i + 40);
    const tipos = {};
    for (const l of janela) {
      const t = TIPOS.find(([, re]) => re.test(l));
      if (!t) continue;
      const grandes = (l.match(/\d[\d.]*(?:,\d+)?/g) || []).map(brNum).filter((x) => x >= 1000);   // compras e vendas em R$ mil (os % são pequenos)
      if (grandes.length >= 2 && !tipos[t[0]]) tipos[t[0]] = [grandes[0], grandes[1]];
    }
    if (!(tipos.est && tipos.inst && tipos.pf)) continue;
    const cab = janela.slice(0, 12).join(' ');
    const datas = [...cab.matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)].map((m) => m[3] + '-' + m[2] + '-' + m[1]).filter((d) => d <= dataBdi);
    const ref = datas.filter((d) => d !== dataBdi).sort().pop() || datas.sort().pop();
    const c = Object.values(tipos).reduce((a, x) => a + x[0], 0), v = Object.values(tipos).reduce((a, x) => a + x[1], 0);
    if (!(c > 0) || Math.abs(c - v) / c > 0.03) { diag.checagem_falhou = { dataBdi, compras: c, vendas: v }; continue; }   // conferência: o que um compra, outro vende
    if (!ref) { diag.sem_data = { dataBdi, trecho: janela.slice(0, 8).join('\n') }; continue; }
    return { ref, tipos };
  }
  return null;
}
const hist = lerJson('fluxo.json', { bdis: {}, acum: {}, enviado: '' });
const VERSAO_LEITOR = 2;   // 2 = reconhece "Investidores Individuais" (21/10/2026); ao subir de versão, as leituras que falharam são refeitas
if (hist.versao !== VERSAO_LEITOR) { for (const k of Object.keys(hist.bdis)) if (hist.bdis[k] === 'falhou') delete hist.bdis[k]; hist.versao = VERSAO_LEITOR; }
async function buscaBdi(iso) {
  if (hist.bdis[iso] && hist.bdis[iso] !== 'falhou') return hist.bdis[iso];
  if (hist.bdis[iso] === 'falhou' && iso < somaDias(HOJE, -5)) return null;   // leitura que já falhou: só tenta de novo nos dias recentes
  const url = BDI_BASE + iso + '/BDI_02_' + iso.replace(/-/g, '') + '.pdf';
  try {
    const buf = await baixar(url);
    if (!buf) { if (iso < somaDias(HOJE, -3)) hist.bdis[iso] = 'nao-existe'; return null; }
    /* a tabela fica na seção "Indicadores e informativos" (página ~42 de ~150): lê só as páginas 20 a 80 e, se não achar, o PDF inteiro */
    let t = null;
    try { t = lerTabela(textoDe(buf, 20, 80), iso); } catch (e) { /* tenta o PDF inteiro */ }
    if (!t) t = lerTabela(textoDe(buf), iso);
    if (!t) { diag.falhas[iso] = 'tabela não encontrada/validada'; diag.trecho = diag.trecho || textoDe(buf).split(/\r?\n/).filter((l) => /investidor|estrangeir|institucion/i.test(l)).slice(0, 12).join('\n'); hist.bdis[iso] = 'falhou'; return null; }
    hist.acum[t.ref] = t.tipos; hist.bdis[iso] = t.ref; diag.lidos++;
    return t.ref;
  } catch (e) { diag.falhas[iso] = e.message; return null; }
}
const saldo = (acum, tipo) => acum[tipo][0] - acum[tipo][1];

/* ---------- séries ---------- */
function diarios() {
  const ks = Object.keys(hist.acum).sort(), out = [];
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i], p = ks[i - 1];
    const mesmo = p && p.slice(0, 7) === k.slice(0, 7);
    if (!mesmo) { if (k.slice(8, 10) <= '04') out.push({ d: k, est: saldo(hist.acum[k], 'est'), inst: saldo(hist.acum[k], 'inst') }); continue; }   // 1º pregão do mês: o acumulado já é o dia
    if ((Date.parse(k + 'T12:00:00Z') - Date.parse(p + 'T12:00:00Z')) / 86400000 > 4) continue;   // faltou algum dia: não dá para separar
    out.push({ d: k, est: saldo(hist.acum[k], 'est') - saldo(hist.acum[p], 'est'), inst: saldo(hist.acum[k], 'inst') - saldo(hist.acum[p], 'inst') });
  }
  return out;
}
function mesesFechados(ano) {
  const r = {};
  for (const k of Object.keys(hist.acum).sort()) r[k.slice(0, 7)] = { ref: k, est: saldo(hist.acum[k], 'est') };   // o último acumulado do mês é o saldo do mês
  return r;
}

/* ---------- envio ---------- */
async function enviarTexto(texto) {
  const r = await fetch(API + '/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: texto, disable_web_page_preview: true }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram recusou: ' + (j.description || 'HTTP ' + r.status));
}
async function enviarFoto(png, legenda) {
  const f = new FormData();
  f.append('chat_id', process.env.TELEGRAM_CHAT_ID); f.append('caption', legenda);
  f.append('photo', new Blob([fs.readFileSync(png)], { type: 'image/png' }), 'fluxo.png');
  const r = await fetch(API + '/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendPhoto', { method: 'POST', body: f, signal: AbortSignal.timeout(40000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram recusou a foto: ' + (j.description || 'HTTP ' + r.status));
}
function grafico(serie, ult) {
  if (process.env.SEM_GRAFICO === '1') return null;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), ent = path.join(dir, 'e.json'), png = path.join(dir, 'g.png');
    fs.writeFileSync(ent, JSON.stringify({ titulo: 'Fluxo Investidor Estrangeiro na B3 (R$ bilhões)', dias: serie.map((x) => x.d.slice(8, 10) + '/' + x.d.slice(5, 7)), valores: serie.map((x) => Math.round(x.est / 1e4) / 100) }));
    execFileSync('python3', [path.join(AQUI, 'grafico-fluxo.py'), ent, png], { timeout: 60000 });
    return png;
  } catch (e) { diag.grafico = 'falhou: ' + String(e.message).slice(0, 200); return null; }
}

try {
  if ((DOW === 0 || DOW === 6) && !FORCAR) { console.log('fim de semana: sem fluxo.'); process.exit(0); }
  /* 1) baixa os BDIs dos últimos pregões que ainda não foram lidos */
  let d = HOJE, n = 0;
  const alvo = [];
  while (n < DIAS_BUSCA) { if (util(d)) { alvo.push(d); n++; } d = somaDias(d, -1); }
  for (const iso of alvo) await buscaBdi(iso);
  /* 2) meses anteriores do ano (para o saldo do ano): o BDI do 2º pregão do mês seguinte traz o acumulado até o último pregão do mês */
  const ano = HOJE.slice(0, 4), mesAtual = Number(HOJE.slice(5, 7));
  hist.fechados = hist.fechados || {};
  for (let m = 1; m < mesAtual; m++) {
    const ym = ano + '-' + String(m).padStart(2, '0');
    if (hist.fechados[ym]) continue;
    let dd = ano + '-' + String(m + 1).padStart(2, '0') + '-01', lidos = 0;   // (só até novembro: dezembro só fecha em janeiro)
    for (let t = 0; t < 10 && lidos < 2; t++, dd = somaDias(dd, 1)) {
      if (!util(dd)) continue;
      const ref = await buscaBdi(dd);
      if (!ref) continue;                        // feriado (sem BDI): não conta
      lidos++;
      if (lidos === 2 && ref.slice(0, 7) === ym) hist.fechados[ym] = true;
    }
  }
  fs.writeFileSync(path.join(SAIDA, 'fluxo.json'), JSON.stringify(hist));
  /* 3) monta a mensagem */
  const dia = diarios();
  diag.dias_calculados = dia.length; diag.ultimo = dia.length ? dia[dia.length - 1].d : null;
  if (!dia.length) throw new Error('não consegui ler nenhum acumulado do BDI (veja o diagnóstico)');
  /* só a sequência contínua mais recente (os fechamentos de meses antigos, buscados só para o saldo do ano, ficam de fora) */
  let ini = dia.length - 1;
  while (ini > 0 && (Date.parse(dia[ini].d + 'T12:00:00Z') - Date.parse(dia[ini - 1].d + 'T12:00:00Z')) / 86400000 <= 4) ini--;
  dia.splice(0, ini);
  const ult = dia[dia.length - 1];
  if (hist.enviado === ult.d && !FORCAR) { console.log('o fluxo de ' + ult.d + ' já foi enviado.'); process.exit(0); }
  const u10 = dia.slice(-10), pos = u10.filter((x) => x.est >= 0).length;
  const meses = mesesFechados(ano), ymU = ult.d.slice(0, 7);
  const mesVal = meses[ymU].est;
  const mesesAno = Array.from({ length: Number(ymU.slice(5, 7)) }, (_, i) => ano + '-' + String(i + 1).padStart(2, '0'));
  const anoCompleto = ymU.slice(0, 4) === ano && mesesAno.every((ym) => meses[ym] && (ym === ymU || hist.fechados[ym]));
  const linhas = ['#fluxo #b3', '', 'Fluxo Investidor Estrangeiro na B3 - Diário em ' + dataBR(ult.d), '',
    bolinha(ult.est) + ' Estrangeiro: ' + valor(ult.est), bolinha(ult.inst) + ' Institucional: ' + valor(ult.inst), '',
    'Últimos ' + u10.length + ' pregões:', '🟢 ' + pos + (pos === 1 ? ' Positivo' : ' Positivos'), '🔴 ' + (u10.length - pos) + (u10.length - pos === 1 ? ' Negativo' : ' Negativos'), 'Saldo do período: ' + valor(u10.reduce((a, x) => a + x.est, 0)), '',
    MESES[Number(ymU.slice(5, 7)) - 1] + '/' + ymU.slice(0, 4) + ': ' + valor(mesVal)];
  if (anoCompleto) linhas.push('Ano ' + ano + ': ' + valor(mesesAno.reduce((a, ym) => a + meses[ym].est, 0)));
  linhas.push('', 'Fonte: B3 (dados com 2 pregões de defasagem). Saldo = compras − vendas no mercado à vista.', 'Conteúdo educacional. Não é recomendação de investimento.', '', '📲 Participe do nosso grupo do Telegram: @planobinvestimentos');
  const texto = linhas.join('\n');
  const png = grafico(dia.slice(-20), ult);
  fs.writeFileSync(path.join(SAIDA, 'fluxo-diag.json'), JSON.stringify(diag, null, 1));
  if (TESTE) { console.log('--- MENSAGEM (teste, não enviada)' + (png ? ' + gráfico ' + png : '') + ' ---\n' + texto + '\n--- fim ---'); if (png) fs.copyFileSync(png, path.join(SAIDA, 'fluxo-teste.png')); process.exit(0); }
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) throw new Error('faltam os segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
  if (png && texto.length <= 1000) { try { await enviarFoto(png, texto); } catch (e) { diag.foto = e.message; await enviarTexto(texto); } } else await enviarTexto(texto);
  console.log('enviado ao Telegram.');
  hist.enviado = ult.d;
  fs.writeFileSync(path.join(SAIDA, 'fluxo.json'), JSON.stringify(hist));
} catch (e) { diag.erro = e.message; console.error('ERRO:', e.message); process.exitCode = 1; }
fs.writeFileSync(path.join(SAIDA, 'fluxo-diag.json'), JSON.stringify(diag, null, 1));
