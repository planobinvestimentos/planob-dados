/* SONDA DO BDI (Boletim Diário da B3): descobre em qual PDF e em que formato está a tabela "Participação dos Investidores" (saldo do estrangeiro).
   Roda só quando você mandar (Actions > "Sonda BDI" > Run workflow). Não envia nada ao Telegram nem mexe no site; grava saida/sonda-bdi.json.
   Para cada um dos 3 últimos pregões, tenta os PDFs BDI_00 a BDI_12, lê o texto e mostra os trechos que falam de investidores. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SAIDA = process.env.SAIDA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'saida');
fs.mkdirSync(SAIDA, { recursive: true });
const BASE = process.env.BDI_BASE || 'https://arquivos.b3.com.br/bdi/download/bdi/';
const UA = { 'User-Agent': 'PlanoB-Investimentos-sonda/1.0 (uso educacional)' };
const diag = { gerado: new Date().toISOString(), pdfs: [], trechos: [] };
const salvar = () => { fs.writeFileSync(path.join(SAIDA, 'sonda-bdi.json'), JSON.stringify(diag, null, 1)); console.log('sonda gravada em saida/sonda-bdi.json'); };
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const hoje = new Date(Date.now() - 3 * 3600 * 1000);
const dias = []; for (let i = 1; dias.length < 3 && i < 12; i++) { const d = new Date(hoje.getTime() - i * 86400000); if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) dias.push(d.toISOString().slice(0, 10)); }
diag.dias = dias;
/* PARTE 1 (nova, 21/10): a página de consulta da B3 "Volume total acumulado" (participação dos investidores) costuma estar 1 pregão à frente do PDF do BDI.
   Procura nela os endereços de dados (API/JSON) e as datas que ela mostra. */
const PAGINAS = ['https://www.b3.com.br/pt_br/market-data-e-indices/servicos-de-dados/market-data/consultas/mercado-a-vista/participacao-dos-investidores/volume-total-acumulado/', 'https://www.b3.com.br/pt_br/market-data-e-indices/servicos-de-dados/market-data/consultas/boletim-diario/boletim-diario-do-mercado/'];
diag.paginas = [];
for (const url of PAGINAS) {
  const item = { url };
  try {
    const r = await fetch(url, { headers: Object.assign({ Accept: 'text/html,application/json,*/*' }, UA), signal: AbortSignal.timeout(60000) });
    const t = await r.text();
    item.status = r.status; item.bytes = t.length;
    item.scripts = [...new Set([...t.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]))].slice(0, 40);
    item.enderecos = [...new Set((t.match(/https?:\/\/[a-z0-9.-]*b3[a-z0-9.-]*\/[^"'\s<>)]{3,160}/gi) || []).filter((u) => /api|json|arquivos|sistemasweb|service|participa|boletim|bdi|download/i.test(u)))].slice(0, 40);
    item.pedacos = [];
    for (const m of t.matchAll(/(participa[çc][ãa]o|investidor|acumulado|iframe|data-url|fetch\(|ajax|\.json|api\/)/gi)) { if (item.pedacos.length >= 12) break; const i = m.index; item.pedacos.push(t.slice(Math.max(0, i - 80), i + 200).replace(/\s+/g, ' ')); }
    item.datas_vistas = [...new Set(t.match(/\d{2}\/\d{2}\/\d{4}/g) || [])].slice(0, 10);
  } catch (e) { item.erro = e.message; }
  diag.paginas.push(item);
  await dorme(800);
}
/* os scripts da página (que não sejam de terceiros) podem ter o endereço do serviço de dados */
for (const it of diag.paginas) {
  for (const src of (it.scripts || []).filter((u) => !/google|gtm|analytics|facebook|hotjar|jquery|cdn|adobe|clarity|maze|ruxit|dynatrace/i.test(u)).slice(0, 6)) {
    try {
      const u = new URL(src, it.url).href;
      const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(60000) });
      const t = await r.text();
      const ends = [...new Set((t.match(/["'`](https?:\/\/[^"'`\s]{6,160}|\/[a-zA-Z0-9_\/.-]*(?:api|json|participa|investidor|service)[a-zA-Z0-9_\/.?=&-]*)["'`]/gi) || []))].slice(0, 25);
      if (ends.length || /participa|investidor/i.test(t)) (diag.scripts_b3 = diag.scripts_b3 || []).push({ script: u, bytes: t.length, enderecos: ends, menciona_participacao: /participa[çc][ãa]o/i.test(t) });
    } catch (e) { /* ignora */ }
    await dorme(500);
  }
}
if (process.env.BDI_PDFS !== '1') { salvar(); process.exit(0); }   // PARTE 2 (os PDFs, já feita em 21/10) só roda com BDI_PDFS=1

try {
  for (const iso of dias) {
    for (let n = 0; n <= 12; n++) {
      const nn = String(n).padStart(2, '0'), url = BASE + iso + '/BDI_' + nn + '_' + iso.replace(/-/g, '') + '.pdf';
      try {
        const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(90000) });
        const buf = Buffer.from(await r.arrayBuffer());
        const item = { iso, n: nn, status: r.status, bytes: buf.length, comeca: buf.subarray(0, 5).toString('latin1') };
        diag.pdfs.push(item);
        if (r.status !== 200 || !item.comeca.startsWith('%PDF')) { await dorme(400); continue; }
        const tmp = path.join(os.tmpdir(), 'sb-' + n + '-' + iso + '.pdf'); fs.writeFileSync(tmp, buf);
        let texto = '';
        try { texto = execFileSync('pdftotext', ['-layout', tmp, '-'], { encoding: 'utf8', timeout: 90000, maxBuffer: 8e7 }); } catch (e) { item.erro_texto = e.message.slice(0, 200); }
        try { item.paginas = (execFileSync('pdfinfo', [tmp], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/) || [])[1]; } catch (e) { /* sem pdfinfo */ }
        try { fs.unlinkSync(tmp); } catch (e) { /* ignora */ }
        item.chars_texto = texto.length;
        item.primeira_linha = texto.split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join(' | ').slice(0, 200);
        const linhas = texto.split(/\r?\n/);
        const achou = []; linhas.forEach((l, i) => { if (/participa[çc][ãa]o\s+d(os|e)\s+investidores|investidores?\s+estrangeir|estrangeiro/i.test(l) && !/edital|companhia|oferta/i.test(l)) achou.push(i); });
        item.linhas_com_investidores = achou.length;
        if (achou.length && diag.trechos.length < 4) diag.trechos.push({ iso, n: nn, linha: achou[0] + 1, contexto: linhas.slice(Math.max(0, achou[0] - 6), achou[0] + 26).map((l) => l.slice(0, 170)).join('\\n') });
      } catch (e) { diag.pdfs.push({ iso, n: nn, erro: e.message }); }
      await dorme(500);
    }
  }
} catch (e) { diag.erro = e.message; }
salvar();
