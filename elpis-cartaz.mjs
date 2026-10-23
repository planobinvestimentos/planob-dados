/* CARTAZ DA ELPIS no Telegram, 1 vez por dia, às 20h30 (Brasília), todos os dias. Roda no GitHub Actions (elpis-cartaz.yml).
   Alterna entre as artes da lista CARTAZES (YouTube, Converse com a Elpis, Imposto de Renda, Aposentadoria, Gastos...), uma por dia, sem repetir a anterior; cada dia envia uma única vez (saida/elpis-cartaz.json).
   As imagens ficam na pasta imagens/ (elpis-cartaz-*); os textos da legenda estão na lista CARTAZES abaixo (use {site} no lugar de https://planobinvestimentos.com).
   Variáveis: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Opcionais: TESTE=1 (só mostra no log, não grava estado), FORCAR=1 (ignora horário e "já enviou hoje"),
   INDICE_TESTE=1..N (escolhe a arte), ELPIS_CARTAZ_HORA (padrão 20:30), SITE_URL, TELEGRAM_API. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RODAPE } from './proventos-msg.mjs';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = process.env.SAIDA_DIR || path.join(RAIZ, 'saida');
const TESTE = process.env.TESTE === '1', FORCAR = process.env.FORCAR === '1';
const SITE = (process.env.SITE_URL || 'https://planobinvestimentos.com').replace(/\/+$/, '');
const [H0, M0] = String(process.env.ELPIS_CARTAZ_HORA || '20:30').split(':').map(Number);
const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T23:40:00Z') : new Date(Date.now() - 3 * 3600 * 1000);   // Brasília (UTC-3)
const HOJE = agora.toISOString().slice(0, 10);
const MIN = process.env.HORA_TESTE ? Number(process.env.HORA_TESTE) * 60 : agora.getUTCHours() * 60 + agora.getUTCMinutes();
const lerJson = (arq, pad = null) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, arq), 'utf8')); } catch (e) { return pad; } };

const CARTAZES = [
  { imagem: 'imagens/elpis-cartaz-1.png', texto: '🎬 Gostou do conteúdo? Inscreva-se no nosso canal do YouTube: vídeos toda semana sobre investimentos, finanças pessoais, criptomoedas e imposto de renda.\n👉 https://www.youtube.com/@planob_investimentos' },
  { imagem: 'imagens/elpis-cartaz-2.png', texto: '💬 Tem dúvidas sobre investimentos? Converse com a Elpis, a guia do Plano B: ela explica ações, FIIs, criptomoedas e planejamento financeiro em linguagem simples. Ela explica e lembra; não recomenda compra nem venda.\n👉 {site}/elpis/' },
  { imagem: 'imagens/elpis-cartaz-aposentadoria.jpg', texto: '🏖️ Simule a sua aposentadoria: descubra o patrimônio necessário, em que idade você chega lá e quanto precisa investir por mês para a renda que deseja. Grátis e sem cadastro.\n👉 {site}/calculadoras/aposentadoria/\n\n📌 Imagem de exemplo, com valores de demonstração. Rendimentos futuros não são garantidos; troque pelos seus números.' },
  { imagem: 'imagens/elpis-cartaz-3.png', texto: '🧾 Já está preparando o Imposto de Renda? A Elpis ajuda a entender como declarar ações, FIIs, ETFs e criptomoedas. É informação educacional: confira sempre as regras e os prazos oficiais da Receita Federal.\n👉 {site}/elpis/' },
  { imagem: 'imagens/elpis-cartaz-gastos.jpg', texto: '💸 Para onde vai o seu dinheiro? Na calculadora de Orçamento Mensal você coloca seus gastos, vê o gráfico em pizza do que pesa mais e quanto sobra no mês. Grátis e sem cadastro.\n👉 {site}/calculadoras/orcamento-mensal/\n\n📌 Imagem de exemplo, com valores de demonstração. Troque pelos seus números.' },
  /* DESLIGADO até a arte ser corrigida (o texto da lousa saiu "A Elpi te mostra"; deve ser "A Elpis"). Para ligar: troque ativo: false por true (ou apague a linha ativo). */
  { ativo: false, imagem: 'imagens/elpis-cartaz-fechamento.jpg', texto: '📊 Acompanhe no site o fechamento do mercado: maiores altas e quedas das ações e dos FIIs de tijolo e de papel, atualizado a cada pregão.\n👉 {site}/cotacoes/bolsa/\n\n📌 Os preços e variações da imagem são apenas um exemplo. Os dados reais e do último pregão estão no site.' }
].filter((c) => c.ativo !== false);
const fim = (m, erro = false) => { console.log(erro ? 'ERRO:' : 'cartaz da Elpis:', m); if (erro) process.exitCode = 1; };

try {
  const estado = lerJson('elpis-cartaz.json', {});
  if (!TESTE && !FORCAR) {
    if (MIN < H0 * 60 + M0) { console.log('cartaz da Elpis: sai a partir das ' + H0 + 'h' + String(M0).padStart(2, '0') + ' (agora ' + Math.floor(MIN / 60) + 'h' + String(MIN % 60).padStart(2, '0') + '); nada a fazer.'); process.exit(0); }
    if (estado.data === HOJE) { console.log('cartaz da Elpis: o de hoje (' + HOJE + ') já foi enviado.'); process.exit(0); }
  }
  let idx = Number.isInteger(estado.proximo) ? estado.proximo % CARTAZES.length : 0;
  if (process.env.INDICE_TESTE) idx = (Number(process.env.INDICE_TESTE) - 1 + CARTAZES.length) % CARTAZES.length;
  const c = CARTAZES[idx];
  const legenda = (c.texto.split('{site}').join(SITE) + '\n\n' + RODAPE + '\n\n📲 Participe do nosso grupo do Telegram: @planobinvestimentos').slice(0, 1024);
  const arq = fs.readFileSync(path.join(RAIZ, c.imagem));
  if (TESTE) { console.log('--- FOTO (teste, não enviada): ' + c.imagem + ' (' + Math.round(arq.length / 1024) + ' KB) ---\n' + legenda + '\n--- fim ---'); process.exit(0); }
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('faltam os segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
  const f = new FormData();
  f.append('chat_id', chat);
  f.append('caption', legenda);
  f.append('photo', new Blob([arq], { type: /\.jpe?g$/i.test(c.imagem) ? 'image/jpeg' : 'image/png' }), path.basename(c.imagem));
  const r = await fetch((process.env.TELEGRAM_API || 'https://api.telegram.org') + '/bot' + token + '/sendPhoto', { method: 'POST', body: f, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram recusou a foto: ' + (j.description || 'HTTP ' + r.status));
  fs.mkdirSync(SAIDA, { recursive: true });
  fs.writeFileSync(path.join(SAIDA, 'elpis-cartaz.json'), JSON.stringify({ data: HOJE, ultima: idx, proximo: (idx + 1) % CARTAZES.length }, null, 1));
  fim('arte ' + (idx + 1) + ' de ' + CARTAZES.length + ' enviada.');
} catch (e) {
  fim(e.message, true);
}
