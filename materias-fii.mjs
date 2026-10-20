/* Matérias do site sobre rendimentos EXTRAORDINÁRIOS de FIIs (aba "Notícias da bolsa"), feitas direto dos dados da B3, sem IA:
   texto padronizado com os números do próprio comunicado (valor por cota, data-base, pagamento, mês de referência)
   e a relação rendimento/preço, calculada com o último fechamento. Rendimento mensal comum NÃO vira matéria (só aparece no Telegram).
   Extraordinário = marcado assim pelo fundo, 2º rendimento do mesmo mês ou valor bem acima do habitual (ver eventos.mjs, campo "extra").
   Chamado pelo telegram.mjs quando envia os proventos. */
import fs from 'node:fs';
import path from 'node:path';
import { lerMaterias, gravarMaterias } from './materias-arquivo.mjs';

const num = (v, c = 2) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });
const brl = (v) => 'R$ ' + num(v, Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? 2 : Math.abs(v * 10000 - Math.round(v * 10000)) < 1e-6 ? 4 : 6);
const dataISO = (br) => { const m = String(br || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; };
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const mesRef = (ref) => {
  const t = String(ref || '').trim();
  let m = t.match(/^([A-Za-zçÇ]+)\s*\/\s*(\d{4})/);
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() + ' de ' + m[2];
  m = t.match(/^(\d{1,2})\s*-\s*(\d{4})/);            // formato "09-2026/2026"
  return m && +m[1] >= 1 && +m[1] <= 12 ? MESES[+m[1] - 1].charAt(0).toUpperCase() + MESES[+m[1] - 1].slice(1) + ' de ' + m[2] : '';
};

export function montarMateriaFii(x, { preco, dataPreco, hoje }) {
  const rend = x.tipo !== 'Amortização';
  const nome = x.fundo ? x.fundo.replace(/\s+/g, ' ').trim() : x.t;
  const ref = mesRef(x.ref);
  const verbo = rend ? 'rendimento' : 'amortização';
  const titulo = x.t + ' anuncia rendimento de ' + brl(x.v) + ' por cota, fora do padrão habitual';
  const resumo = x.t + ' vai pagar ' + brl(x.v) + ' por cota em ' + (x.pag || 'data a definir') + (ref ? ', referente a ' + ref.toLowerCase() : '') + '. Data-base: ' + (x.base || 'a definir') + '.';
  const par = [];
  par.push('O fundo imobiliário ' + nome + ' (' + x.t + ') anunciou ' + (rend ? 'um rendimento fora do padrão habitual' : 'uma amortização') + ' de ' + brl(x.v) + ' por cota' + (ref ? ', referente a ' + ref.toLowerCase() : '') + '. ' +
    'Têm direito ao pagamento os cotistas que estiverem com a cota na data-base, ' + (x.base || 'a definir') + '; o pagamento será feito em ' + (x.pag || 'data a definir') + '.');
  if (preco > 0 && rend) {
    const dy = (x.v / preco) * 100;
    par.push('Em relação ao último fechamento registrado pela B3 (' + brl(preco) + (dataPreco ? ', em ' + dataPreco.slice(8, 10) + '/' + dataPreco.slice(5, 7) : '') + '), o valor anunciado equivale a ' + num(dy) + '% da cota. É uma conta simples sobre um único mês; o rendimento de um mês não garante os próximos.');
  }
  if (x.extra) par.push('Por que esta matéria: o Plano B só publica no site os rendimentos fora do comum. Neste caso, o motivo é ' + x.extra + '. Confira no comunicado do fundo se é distribuição extraordinária, antecipação ou outro tipo.');
  if (!rend) par.push('Amortização devolve parte do capital investido ao cotista; ela não é rendimento e o valor da cota é ajustado de acordo com as regras do fundo.');
  par.push('Data-base é o último dia em que o investidor precisa ter a cota na carteira para receber o provento. Quem compra depois dessa data negocia a cota sem direito a esse pagamento.');
  const slug = (hoje + '-' + x.t + '-' + (rend ? 'rendimento' : 'amortizacao') + '-' + dataISO(x.pag).replace(/-/g, '')).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return {
    slug, chave: 'fii|' + [x.t, x.tipo, x.base, x.pag, x.v].join('|'), data: hoje, titulo, resumo, paragrafos: par, tipo: 'dividendos',
    empresa: nome, tickers: [x.t], setor: 'fii',
    fonte: { categoria: 'Proventos em dinheiro de fundos listados (B3)', assunto: '', link: '' }, criada: new Date().toISOString(),
  };
}

/* grava (ou atualiza) saida/materias.json com as matérias novas; devolve quantas entraram */
export function gravarMateriasFii(itens, { saida, precos = {}, dataPreco = '', hoje, max = 25 }) {
  const atual = lerMaterias(saida);   // se o arquivo existir e estiver ilegível, para aqui (não apaga matérias)
  const existentes = new Set((atual.materias || []).map((m) => m.chave));
  const novas = [];
  for (const x of itens.filter((i) => i.extra && i.tipo !== 'Amortização').slice(0, max)) {
    const m = montarMateriaFii(x, { preco: precos[x.t], dataPreco, hoje });
    if (existentes.has(m.chave) || novas.some((n) => n.slug === m.slug)) continue;
    novas.push(m);
  }
  if (!novas.length) return 0;
  gravarMaterias(saida, novas, atual.materias || []);
  return novas.length;
}
