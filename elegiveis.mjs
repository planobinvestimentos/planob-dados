/* Lista de empresas "elegíveis" do Plano B: lucro em todos os últimos N anos e dividendos/JCP pagos em todos eles.
   Roda no GitHub Actions (.github/workflows/elegiveis.yml, 1 vez por mês):  node elegiveis.mjs
   Fonte: CVM, dados abertos DFP (demonstrações anuais): DRE (lucro líquido) e DFC (dividendos e JCP pagos).
   Resultado: saida/elegiveis.json (usado pelo noticias.mjs) e saida/elegiveis-diag.json (conferência).
   Opcionais: ANOS (padrão 5), DFP_DIR (pasta com os zips, só para teste), ANO_BASE (padrão: ano atual). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerZip, lerCsv } from './lib.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = process.env.SAIDA_DIR || path.join(AQUI, 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const CVM = process.env.CVM_URL || 'https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/';
const UA = { 'user-agent': 'Mozilla/5.0 (planob-dados)' };
const N = Number(process.env.ANOS) || 5;
const ANO_BASE = Number(process.env.ANO_BASE) || new Date().getUTCFullYear();
let ANOS = Array.from({ length: N }, (_, i) => ANO_BASE - N + i);          // ex.: 2021..2025 (o exercício do ano corrente ainda não fechou)
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const so = (s) => String(s || '').replace(/\D/g, '');
const num = (s) => { s = String(s).trim(); const v = parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); return Number.isFinite(v) ? v : NaN; };
const diag = { gerado: new Date().toISOString(), anos: ANOS };

async function baixar(url, tentativas = 3) {
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(180000), redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { ultimo = e; await new Promise((ok) => setTimeout(ok, 3000 * (i + 1))); }
  }
  throw new Error('download falhou (' + url + '): ' + ultimo.message + (ultimo.cause ? ' [' + (ultimo.cause.code || ultimo.cause.message) + ']' : ''));
}

const anoDe = (r) => String(r.DT_FIM_EXERC || r.DT_REFER || '').slice(0, 4);
const versao = (r) => String(r.VERSAO || '0').padStart(3, '0');

/* lê um ano: devolve { lucro: Map(cnpj -> valor), nome: Map(cnpj -> nome), div: Set(cnpj) } */
async function lerAno(ano) {
  const arq = 'dfp_cia_aberta_' + ano + '.zip';
  const buf = process.env.DFP_DIR ? fs.readFileSync(path.join(process.env.DFP_DIR, arq)) : await baixar(CVM + 'DFP/DADOS/' + arq);
  const zip = lerZip(buf);
  const linhasDe = (re) => { let l = []; zip.forEach((b, nome) => { if (re.test(nome)) l = l.concat(lerCsv(b)); }); return l; };
  const nome = new Map(), lucro = new Map(), div = new Set();

  /* lucro líquido: consolidado primeiro; o individual só entra se a empresa não tiver consolidado */
  const dreCon = linhasDe(/DRE_con_/i), dreInd = linhasDe(/DRE_ind_/i);
  const pegaLucro = (linhas, destino) => {
    const por = new Map();
    for (const r of linhas) {
      if (norm(r.ORDEM_EXERC) !== 'ULTIMO' || anoDe(r) !== String(ano)) continue;
      const k = so(r.CNPJ_CIA); if (!k) continue;
      nome.set(k, r.DENOM_CIA || nome.get(k) || '');
      const v = versao(r), a = por.get(k);
      if (!a || a.v < v) por.set(k, { v, rows: [r] }); else if (a.v === v) a.rows.push(r);
    }
    por.forEach((o, k) => {
      if (destino.has(k)) return;
      let r = o.rows.find((x) => x.CD_CONTA === '3.11');
      if (!r) { // reserva: a conta de nível 3.NN cujo nome é "Lucro/Prejuízo ... do Período/Exercício" (a de maior código)
        r = o.rows.filter((x) => /^3\.\d{2}$/.test(x.CD_CONTA) && /^(LUCRO|RESULTADO).*(DO PERIODO|DO EXERCICIO)/.test(norm(x.DS_CONTA))).sort((a, b) => b.CD_CONTA.localeCompare(a.CD_CONTA))[0];
      }
      if (!r) return;
      const val = num(r.VL_CONTA); if (Number.isFinite(val)) destino.set(k, val);
    });
  };
  pegaLucro(dreCon, lucro); pegaLucro(dreInd, lucro);

  /* dividendos e JCP pagos: demonstração do fluxo de caixa, grupo 6.03 (financiamento), valor negativo */
  for (const r of linhasDe(/DFC_(MD|MI)_(con|ind)_/i)) {
    if (norm(r.ORDEM_EXERC) !== 'ULTIMO' || anoDe(r) !== String(ano)) continue;
    const ds = norm(r.DS_CONTA);
    if (!/^6\.03\./.test(r.CD_CONTA || '') || !/DIVIDENDO|JUROS SOBRE (O )?CAPITAL|JCP|PROVENTO/.test(ds) || /RECEB/.test(ds)) continue;
    const val = num(r.VL_CONTA);
    if (Number.isFinite(val) && val < 0) div.add(so(r.CNPJ_CIA));
  }
  diag['ano_' + ano] = { empresas_com_lucro_lido: lucro.size, empresas_com_dividendo_pago: div.size, linhas_dre: dreCon.length + dreInd.length };
  return { lucro, nome, div };
}

const dados = {};
/* em janeiro a março o balanço do ano anterior pode não ter sido publicado: recua a janela em 1 ano */
try { dados[ANOS[ANOS.length - 1]] = await lerAno(ANOS[ANOS.length - 1]); }
catch (e) { if (/HTTP 404|ENOENT/.test(e.message)) { ANOS = ANOS.map((a) => a - 1); diag.anos = ANOS; diag.aviso = 'balanço do último ano ainda não publicado; janela recuada'; } }
for (const ano of ANOS) {
  if (dados[ano]) continue;
  try { dados[ano] = await lerAno(ano); console.log('ano', ano, JSON.stringify(diag['ano_' + ano])); }
  catch (e) { diag['erro_' + ano] = e.message; console.error('ERRO ano', ano + ':', e.message); }
}
if (Object.keys(dados).length < ANOS.length || ANOS.some((a) => !dados[a].lucro.size)) {
  diag.erro = 'não consegui ler todos os anos da CVM; lista anterior mantida'; fs.writeFileSync(path.join(SAIDA, 'elegiveis-diag.json'), JSON.stringify(diag, null, 1));
  console.error('ERRO:', diag.erro); process.exit(1);
}

/* quem passa: lucro > 0 e dividendo pago em TODOS os anos */
const todos = new Set(); ANOS.forEach((a) => dados[a].lucro.forEach((_, k) => todos.add(k)));
const empresas = {}, motivos = { prejuizo: 0, sem_dividendo: 0, historico_incompleto: 0 }, nomes = {};
const detalhe = (k) => ANOS.map((a) => ({ ano: a, lucro: dados[a].lucro.has(k) ? (dados[a].lucro.get(k) > 0 ? 'lucro' : 'PREJUIZO') : 'sem dado', dividendo: dados[a].div.has(k) ? 'pagou' : 'nao pagou' }));
for (const k of todos) {
  const nome = ANOS.map((a) => dados[a].nome.get(k)).filter(Boolean).pop() || '';
  nomes[k] = nome;
  if (ANOS.some((a) => !dados[a].lucro.has(k))) { motivos.historico_incompleto++; continue; }
  if (ANOS.some((a) => dados[a].lucro.get(k) <= 0)) { motivos.prejuizo++; continue; }
  if (ANOS.some((a) => !dados[a].div.has(k))) { motivos.sem_dividendo++; continue; }
  empresas[k] = nome;
}

/* tickers (se o noticiário já montou o cadastro CNPJ -> códigos) */
let tk = {}; try { tk = JSON.parse(fs.readFileSync(path.join(SAIDA, 'cnpj-tickers.json'), 'utf8')).m || {}; } catch (e) { /* ignora */ }
const lista = Object.keys(empresas).map((k) => ({ cnpj: k, nome: empresas[k], tickers: (tk[k] || []).join(' ') })).sort((a, b) => a.nome.localeCompare(b.nome));
if (Object.keys(empresas).length < 10) { diag.erro = 'poucas empresas aprovadas (' + Object.keys(empresas).length + '): confira as contas da CVM; lista anterior mantida'; fs.writeFileSync(path.join(SAIDA, 'elegiveis-diag.json'), JSON.stringify(diag, null, 1)); console.error('ERRO:', diag.erro); process.exit(1); }
/* exceções por setor (cadastro da CVM): todas as empresas de energia elétrica, bancos e saneamento entram, mesmo sem passar no filtro */
let padroes = ['ENERGIA ELETRICA', 'BANCOS', 'SANEAMENTO'];
try { const c = JSON.parse(fs.readFileSync(path.join(AQUI, 'destaques.json'), 'utf8')).setores_excecao; if (Array.isArray(c) && c.length) padroes = c.map(norm); } catch (e) { /* usa o padrão */ }
const excecaoSetor = {}, setoresVistos = {};
try {
  const bufCad = process.env.DFP_DIR ? fs.readFileSync(path.join(process.env.DFP_DIR, 'cad_cia_aberta.csv')) : await baixar(new URL('../CAD/DADOS/cad_cia_aberta.csv', CVM).href);
  for (const r of lerCsv(bufCad)) {
    const setor = norm(r.SETOR_ATIV || ''), k = so(r.CNPJ_CIA); if (!k || !setor) continue;
    if (r.SIT && !/ATIVO/.test(norm(r.SIT))) continue;
    if (padroes.some((x) => setor.includes(x))) { excecaoSetor[k] = r.SETOR_ATIV; setoresVistos[r.SETOR_ATIV] = (setoresVistos[r.SETOR_ATIV] || 0) + 1; }
  }
  diag.setores_incluidos = setoresVistos; diag.empresas_por_setor = Object.keys(excecaoSetor).length;
} catch (e) { diag.setores_erro = e.message; console.error('aviso setores:', e.message); }
fs.writeFileSync(path.join(SAIDA, 'elegiveis.json'), JSON.stringify({ gerado: diag.gerado.slice(0, 10), anos: ANOS, criterio: 'lucro líquido positivo e dividendos/JCP pagos em todos os anos', empresas, excecao_setor: excecaoSetor, lista }, null, 1));

/* conferência: algumas empresas conhecidas, ano a ano */
const confere = /ITAU UNIBANCO|BRADESCO|PETROLEO BRASILEIRO|VALE S|TAESA|BANCO DO BRASIL|CEMIG|KLABIN|SANEAMENTO.*(PARANA|MINAS)|WEG|SANTANDER|BANRISUL|CAIXA SEGURIDADE|TRANSMISSAO PAULISTA|ISA CTEEP|TELEFONICA|ENGIE|EQUATORIAL/;
diag.conferir = Object.keys(nomes).filter((k) => confere.test(norm(nomes[k]))).slice(0, 25).map((k) => ({ nome: nomes[k], aprovada: !!empresas[k], anos: detalhe(k).map((d) => d.ano + ':' + d.lucro + '/' + d.dividendo).join(' | ') }));
diag.aprovadas = Object.keys(empresas).length; diag.reprovadas = motivos; diag.total_analisadas = todos.size;
fs.writeFileSync(path.join(SAIDA, 'elegiveis-diag.json'), JSON.stringify(diag, null, 1));
console.log('elegíveis:', diag.aprovadas, 'de', diag.total_analisadas, '| reprovadas:', JSON.stringify(motivos));
