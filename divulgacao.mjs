/* DIVULGAÇÃO DO SITE no Telegram, duas vezes ao dia (padrão: 8h e 19h, Brasília, todos os dias). Roda no GitHub Actions (.github/workflows/divulgacao.yml).
   Convida o pessoal a explorar o site e usar as calculadoras (orçamento mensal, rumo ao primeiro milhão, cripto etc.).
   Os textos ficam em divulgacao.json (editável pelo lápis do GitHub). O robô alterna entre eles, sem repetir o anterior, e envia cada edição uma única vez (saida/divulgacao-estado.json).
   Variáveis: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Opcionais: TESTE=1 (só mostra no log, ignora horário, não grava estado), FORCAR=1 (ignora horário e "já enviou"),
   TODAS=1 (com TESTE: mostra todas as mensagens), DIVULGACAO_HORAS (padrão "8,19"), SITE_URL. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enviarTexto, RODAPE, ASSINATURA } from './proventos-msg.mjs';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = process.env.SAIDA_DIR || path.join(RAIZ, 'saida');
const TESTE = process.env.TESTE === '1', FORCAR = process.env.FORCAR === '1', TODAS = process.env.TODAS === '1';
const SITE = (process.env.SITE_URL || 'https://planobinvestimentos.com').replace(/\/+$/, '');
const HORAS = String(process.env.DIVULGACAO_HORAS || '8,19').split(',').map((x) => Number(x.trim())).filter((x) => x >= 0);
const agora = process.env.DATA_TESTE ? new Date(process.env.DATA_TESTE + 'T11:00:00Z') : new Date(Date.now() - 3 * 3600 * 1000);   // Brasília (UTC-3)
const HOJE = agora.toISOString().slice(0, 10);
const HORA = process.env.HORA_TESTE ? Number(process.env.HORA_TESTE) : agora.getUTCHours();
const MINUTO = process.env.MINUTO_TESTE ? Number(process.env.MINUTO_TESTE) : agora.getUTCMinutes();
const lerJson = (arq, pad = null) => { try { return JSON.parse(fs.readFileSync(path.join(SAIDA, arq), 'utf8')); } catch (e) { return pad; } };
const gravar = (arq, obj) => { try { fs.mkdirSync(SAIDA, { recursive: true }); fs.writeFileSync(path.join(SAIDA, arq), JSON.stringify(obj, null, 1)); } catch (e) { console.warn('aviso: não consegui gravar', arq + ':', e.message); } };
const fim = (m, erro = false) => { console.log(erro ? 'ERRO:' : 'divulgação:', m); if (erro) process.exitCode = 1; };

const montar = (t) => t.split('{site}').join(SITE) + '\n\n' + RODAPE;

/* envia o texto; se houver imagem, vai como foto com o texto na legenda (limite do Telegram: 1024 caracteres; se passar, a foto vai primeiro e o texto logo depois) */
async function enviarMensagem(m) {
  const texto = montar(m.texto);
  let arq = null;
  if (m.imagem) {
    try { arq = fs.readFileSync(path.join(RAIZ, m.imagem)); } catch (e) { console.warn('aviso: imagem não encontrada (' + m.imagem + '); enviando só o texto.'); }
  }
  if (!arq) return enviarTexto(texto, { teste: TESTE });
  const legenda = texto + ASSINATURA, cabe = legenda.length <= 1024;
  if (TESTE) { console.log('--- FOTO (teste, não enviada): ' + m.imagem + ' (' + Math.round(arq.length / 1024) + ' KB) ---'); if (!cabe) return enviarTexto(texto, { teste: true }); console.log('legenda:\n' + legenda + '\n--- fim ---'); return; }
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('faltam os segredos TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID');
  const f = new FormData();
  f.append('chat_id', chat);
  if (cabe) f.append('caption', legenda);
  f.append('photo', new Blob([arq], { type: /\.jpe?g$/i.test(m.imagem) ? 'image/jpeg' : 'image/png' }), path.basename(m.imagem));
  const r = await fetch((process.env.TELEGRAM_API || 'https://api.telegram.org') + '/bot' + token + '/sendPhoto', { method: 'POST', body: f, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram recusou a foto: ' + (j.description || 'HTTP ' + r.status));
  console.log('foto enviada ao Telegram.');
  if (!cabe) await enviarTexto(texto, { teste: false });
}

try {
  let msgs = [];
  try { msgs = (JSON.parse(fs.readFileSync(path.join(RAIZ, 'divulgacao.json'), 'utf8')).mensagens || []).map((x) => (typeof x === 'string' ? { texto: x } : { texto: x && x.texto, imagem: x && x.imagem })).map((x) => ({ texto: String(x.texto || '').trim(), imagem: x.imagem || '' })).filter((x) => x.texto); } catch (e) { throw new Error('não consegui ler divulgacao.json: ' + e.message); }
  if (!msgs.length) throw new Error('divulgacao.json sem mensagens');
  if (TESTE && TODAS) { msgs.forEach((m, i) => console.log('--- mensagem ' + (i + 1) + ' de ' + msgs.length + (m.imagem ? ' (com imagem ' + m.imagem + ')' : '') + ' ---\n' + montar(m.texto))); process.exit(0); }

  const estado = lerJson('divulgacao-estado.json', {});
  const slots = estado.data === HOJE && estado.slots ? Object.assign({}, estado.slots) : {};
  if (!TESTE && !FORCAR) {
    if (!HORAS.includes(HORA)) { console.log('divulgação: edições às ' + HORAS.join('h e ') + 'h (agora ' + HORA + 'h); nada a fazer.'); process.exit(0); }
    if (slots[HORA]) { console.log('divulgação: a edição das ' + HORA + 'h já foi enviada.'); process.exit(0); }
  }
  /* escolha: avança 1 por edição; nunca repete a anterior (mesmo se você editar a lista) */
  let idx = Number.isInteger(estado.proximo) ? estado.proximo % msgs.length : 0;   // 1ª vez: começa pela primeira mensagem
  if (process.env.INDICE_TESTE) idx = (Number(process.env.INDICE_TESTE) - 1 + msgs.length) % msgs.length;
  await enviarMensagem(msgs[idx]);
  if (!TESTE) gravar('divulgacao-estado.json', { data: HOJE, slots: Object.assign(slots, { [HORA]: true }), ultima: idx, proximo: (idx + 1) % msgs.length });
  fim('edição das ' + HORA + 'h enviada (mensagem ' + (idx + 1) + ' de ' + msgs.length + ')');
} catch (e) {
  fim(e.message, true);
}
