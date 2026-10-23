/* Assinatura da Elpis nas mensagens de texto do Telegram: uma dica educativa por dia (a mesma o dia todo), seguida do convite do grupo.
   Regra da ficha da Elpis: ela explica e lembra, NUNCA recomenda compra ou venda. Para trocar ou acrescentar dicas, edite a lista abaixo. */
export const DICAS = [
  'diversificar ajuda a não depender de um só ativo.',
  'dividendo não é lucro garantido: o preço da ação ou da cota pode cair depois que ele é pago.',
  'reserva de emergência vem antes de qualquer investimento de risco.',
  'rentabilidade passada não garante resultado futuro.',
  'antes de investir, entenda como o ativo gera retorno e quais são os riscos.',
  'o dividend yield muda: ele depende do preço de hoje e dos proventos dos últimos meses.',
  'fato relevante é um comunicado oficial: leia o documento original, não só a manchete.',
  'FII paga rendimento mensal, mas o valor pode variar de um mês para outro.',
  'quem compra até a data com recebe o provento; quem compra a partir da data ex, não.',
  'investir aos poucos, todo mês, reduz o peso de escolher o momento exato.',
  'custos e impostos diminuem o retorno: olhe o resultado líquido.',
  'liquidez é a facilidade de vender sem mexer no preço; nem todo ativo tem muita.',
  'mercado sobe e desce; o que importa é o seu prazo e o seu objetivo.',
  'taxas de administração e de performance reduzem o retorno do fundo.',
  'cripto oscila muito: invista só o que você aceita ver variar bastante.',
  'não existe retorno alto sem risco alto. Desconfie de promessa de ganho garantido.',
  'JCP tem imposto na fonte; dividendos têm regras próprias. Confira as regras vigentes.',
  'revisar a carteira de tempos em tempos ajuda a manter o plano original.',
  'informação não é recomendação: decida com base no seu perfil e nos seus objetivos.',
  'notícia do dia raramente muda o seu plano de longo prazo.',
  'compare o rendimento com a inflação: o que importa é o ganho acima dela.',
  'ETF é uma cesta de ativos negociada em bolsa; ainda assim, o preço oscila.',
  'ao ouvir uma dica "quente", pergunte: quem ganha se eu fizer isso?',
  'conferir a fonte oficial (B3, CVM, Banco Central) evita erro de informação.'
];
const diaDoAno = () => { const h = new Date(Date.now() - 3 * 3600 * 1000); return Math.floor(Date.parse(h.toISOString().slice(0, 10)) / 86400000); };
export const dicaDoDia = () => DICAS[diaDoAno() % DICAS.length];
/* texto que vai no fim da mensagem */
export const ASSINATURA_ELPIS = () => '\n\n🌟 Elpis lembra: ' + dicaDoDia() + '\n\n📲 Participe do nosso grupo do Telegram: @planobinvestimentos';
