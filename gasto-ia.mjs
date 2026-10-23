/* Teto de gasto mensal com IA das MATÉRIAS (noticias.mjs e fatos-fii.mjs usam o mesmo contador).
   Guarda em saida/gasto-ia.json quanto já foi gasto no mês (estimado pelos tokens que a API informa).
   Passou do teto (padrão US$ 5 por mês), o robô para de pedir matérias à IA até o mês seguinte:
   o noticiário do Telegram continua saindo, só com as manchetes. Mude o teto com TETO_IA_USD no .yml. */
import fs from 'node:fs';
import path from 'node:path';

/* US$ por milhão de tokens (entrada, saída). Modelos que não conhecemos usam o preço mais alto, para errar a favor da segurança. */
const PRECOS = [[/haiku-5/i, [0.10, 0.50]], [/haiku/i, [1, 5]], [/sonnet/i, [3, 15]], [/opus/i, [5, 25]]];
const precoDe = (modelo) => { const p = PRECOS.find(([re]) => re.test(modelo || '')); return p ? p[1] : [5, 25]; };

export function criarGasto(saidaDir, tetoUsd) {
  const arq = path.join(saidaDir, 'gasto-ia.json');
  const mes = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7);
  const teto = Number(tetoUsd) > 0 ? Number(tetoUsd) : 5;
  let st = {};
  try { st = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { st = {}; }
  if (st.mes !== mes) st = { mes, micro_usd: 0, chamadas: 0 };
  const gravar = () => { try { fs.writeFileSync(arq, JSON.stringify({ mes: st.mes, micro_usd: st.micro_usd, usd: Number((st.micro_usd / 1e6).toFixed(4)), chamadas: st.chamadas, teto_usd: teto })); } catch (e) { /* ignora */ } };
  return {
    teto,
    estourou: () => st.micro_usd >= teto * 1e6,
    gasto: () => st.micro_usd / 1e6,
    somar(modelo, uso) {
      const [pe, ps] = precoDe(modelo), u = uso || {};
      const entrada = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
      st.micro_usd += Math.max(1, Math.ceil(entrada * pe + (u.output_tokens || 0) * ps)); st.chamadas++;
      gravar();
    },
    resumo: () => ({ mes: st.mes, usd: Number((st.micro_usd / 1e6).toFixed(4)), chamadas: st.chamadas, teto_usd: teto })
  };
}
