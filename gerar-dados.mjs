/* Gera dois arquivos pequenos que o site lê direto, sem servidor:
     saida/d1.json           fechamento do dia anterior (B3, dados de D-1 liberados sem custo)
     saida/fundamentos.json  LPA e VPA do último balanço anual (CVM, dados abertos)
   Uso:  node dados/gerar-dados.mjs [d1|fund|tudo]      (Node 18 ou mais novo) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerZip, lerCotahist, urlCotahistDia, lerCsv, lerFundamentos } from './lib.mjs';

const SAIDA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const modo = process.argv[2] || 'tudo';
const UA = { 'User-Agent': 'PlanoB-Investimentos-dados/1.0 (uso educacional)' };

async function baixar(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return Buffer.from(await r.arrayBuffer());
}

async function d1() {
  const hoje = new Date();
  for (let i = 1; i <= 10; i++) {
    const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - i));
    if ([0, 6].includes(d.getUTCDay())) continue;
    const url = urlCotahistDia(d);
    try {
      const zip = lerZip(await baixar(url)), arq = [...zip.keys()][0];
      const { data, precos } = lerCotahist(zip.get(arq).toString('latin1'));
      const n = Object.keys(precos).length;
      if (n < 100) { console.warn('poucos ativos em', url, n); continue; }
      fs.writeFileSync(path.join(SAIDA, 'd1.json'), JSON.stringify({ data, fonte: 'B3, cotações históricas (D-1)', p: precos }));
      console.log('d1 ok:', data, n, 'ativos');
      return;
    } catch (e) { console.warn('sem arquivo:', e.message); }
  }
  throw new Error('nenhum arquivo de fechamento encontrado nos últimos 10 dias');
}

async function fund() {
  const ano = new Date().getUTCFullYear(), base = 'https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/';
  const juntar = (zips, padrao) => {
    let linhas = [];
    zips.forEach((z) => z.forEach((buf, nome) => { if (padrao.test(nome)) linhas = linhas.concat(lerCsv(buf)); }));
    return linhas;
  };
  const dfp = [], fca = [];
  for (const y of [ano, ano - 1, ano - 2]) {
    try { dfp.push(lerZip(await baixar(base + 'DFP/DADOS/dfp_cia_aberta_' + y + '.zip'))); } catch (e) { console.warn('dfp', y, e.message); }
  }
  for (const y of [ano, ano - 1]) {
    try { fca.push(lerZip(await baixar(base + 'FCA/DADOS/fca_cia_aberta_' + y + '.zip'))); } catch (e) { console.warn('fca', y, e.message); }
  }
  if (!dfp.length || !fca.length) throw new Error('não foi possível baixar os arquivos da CVM');
  /* individual primeiro e consolidado depois: o consolidado vence quando a empresa tem os dois */
  const dre = juntar(dfp, /DRE_ind_/i).concat(juntar(dfp, /DRE_con_/i)), bpp = juntar(dfp, /BPP_ind_/i).concat(juntar(dfp, /BPP_con_/i)), capital = juntar(dfp, /composicao_capital/i);
  const fcaL = juntar(fca, /valor_mobiliario/i);
  console.log('linhas:', { dre: dre.length, bpp: bpp.length, capital: capital.length, fca: fcaL.length });
  const dfc = juntar(dfp, /DFC_MD_ind_/i).concat(juntar(dfp, /DFC_MI_ind_/i), juntar(dfp, /DFC_MD_con_/i), juntar(dfp, /DFC_MI_con_/i));
  const itens = lerFundamentos({ dre, bpp, capital, fca: fcaL, dfc });
  const n = Object.keys(itens).length;
  if (n < 50) throw new Error('poucos ativos com fundamentos (' + n + '): confira os nomes das colunas da CVM');
  fs.writeFileSync(path.join(SAIDA, 'fundamentos.json'), JSON.stringify({ gerado: new Date().toISOString().slice(0, 10), fonte: 'CVM, dados abertos (DFP e FCA)', itens }));
  console.log('fundamentos ok:', n, 'ativos');
}

let falhou = false;
if (modo === 'd1' || modo === 'tudo') await d1().catch((e) => { console.error('ERRO d1:', e.message); falhou = true; });
if (modo === 'fund' || modo === 'tudo') await fund().catch((e) => { console.error('ERRO fundamentos:', e.message); falhou = true; });
process.exit(falhou ? 1 : 0);
