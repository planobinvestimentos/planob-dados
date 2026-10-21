/* Liquidez diária dos FIIs (volume médio negociado por pregão), a partir dos arquivos de cotações históricas da B3.
   Roda no GitHub Actions (.github/workflows/liquidez.yml, toda semana):  node liquidez.mjs
   Resultado: saida/liquidez-fiis.json  → só os FIIs com média diária acima do mínimo (padrão R$ 100 mil por dia: só deixa de fora fundo praticamente sem negociação).
   Esse arquivo diz quais FIIs entram nos avisos de rendimentos (Telegram) e nas matérias do site.
   Opcionais: PREGOES (padrão 21, cerca de 1 mês), MIN_LIQUIDEZ (padrão 100000), COTAHIST_BASE, DATA_TESTE=AAAA-MM-DD. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerZip, lerCotahistBolsa, urlCotahistDia } from './lib.mjs';
import { classe } from './eventos.mjs';

const SAIDA = process.env.SAIDA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const PREGOES = Number(process.env.PREGOES) || 21;
const MINIMO = Number(process.env.MIN_LIQUIDEZ) || 100000;
const UA = { 'User-Agent': 'PlanoB-Investimentos-dados/1.0 (uso educacional)' };
const diag = { gerado: new Date().toISOString(), pregoes_pedidos: PREGOES, minimo: MINIMO };

async function baixar(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return Buffer.from(await r.arrayBuffer());
}

const hoje = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T15:00:00Z') : new Date(Date.now() - 3 * 3600 * 1000);
const soma = {}, dias = [];
for (let i = 0; i <= 60 && dias.length < PREGOES; i++) {
  const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - i));
  if ([0, 6].includes(d.getUTCDay())) continue;
  try {
    const zip = lerZip(await baixar(urlCotahistDia(d))), arq = [...zip.keys()][0];
    const r = lerCotahistBolsa(zip.get(arq).toString('latin1'));
    if (Object.keys(r.itens).length < 100) continue;
    dias.push(r.data);
    for (const [tk, a] of Object.entries(r.itens)) if (classe(a) === 'FII') soma[tk] = (soma[tk] || 0) + (a.vol || 0);
  } catch (e) { /* feriado ou arquivo do dia ainda não publicado */ }
}
if (dias.length < Math.min(10, PREGOES)) {
  diag.erro = 'poucos pregões encontrados (' + dias.length + '); lista anterior mantida';
  fs.writeFileSync(path.join(SAIDA, 'liquidez-diag.json'), JSON.stringify(diag, null, 1));
  console.error('ERRO:', diag.erro); process.exit(1);
}
const fiis = {};
let total = 0;
for (const [tk, v] of Object.entries(soma)) {
  total++;
  const media = v / dias.length;
  if (media >= MINIMO) fiis[tk] = Math.round(media);
}
dias.sort();
const ordem = Object.entries(fiis).sort((a, b) => b[1] - a[1]);
fs.writeFileSync(path.join(SAIDA, 'liquidez-fiis.json'), JSON.stringify({ gerado: diag.gerado.slice(0, 10), pregoes: dias.length, de: dias[0], ate: dias[dias.length - 1], minimo: MINIMO, fiis }));
Object.assign(diag, { pregoes: dias.length, de: dias[0], ate: dias[dias.length - 1], fiis_analisados: total, fiis_acima_do_minimo: ordem.length, maiores: ordem.slice(0, 15).map(([t, v]) => t + ' R$ ' + (v / 1e6).toFixed(1) + ' mi') });
fs.writeFileSync(path.join(SAIDA, 'liquidez-diag.json'), JSON.stringify(diag, null, 1));
console.log('liquidez ok:', dias.length, 'pregões,', total, 'FIIs,', ordem.length, 'acima de R$', MINIMO / 1e6, 'mi/dia');
