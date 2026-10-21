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
