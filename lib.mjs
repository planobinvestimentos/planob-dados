/* Leitura dos arquivos públicos da B3 (cotações históricas, fechamento do dia anterior) e da CVM (dados abertos).
   Sem dependências: usa só o Node 18 ou mais novo. */
import zlib from 'node:zlib';

/* ---------- ZIP mínimo ---------- */
export function lerZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('zip inválido');
  const total = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const arquivos = new Map();
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: diretório corrompido');
    const metodo = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20);
    const n = buf.readUInt16LE(p + 28), x = buf.readUInt16LE(p + 30), c = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const nome = buf.toString('utf8', p + 46, p + 46 + n);
    const ln = buf.readUInt16LE(off + 26), lx = buf.readUInt16LE(off + 28), ini = off + 30 + ln + lx;
    const dados = buf.subarray(ini, ini + comp);
    arquivos.set(nome, metodo === 0 ? Buffer.from(dados) : zlib.inflateRawSync(dados));
    p += 46 + n + x + c;
  }
  return arquivos;
}

/* ---------- B3: COTAHIST (245 caracteres por linha, preços com 2 casas implícitas) ---------- */
export function lerCotahist(texto) {
  const precos = {};
  let data = '';
  for (const linha of texto.split('\n')) {
    if (linha.length < 217 || linha.slice(0, 2) !== '01') continue;
    if (linha.slice(24, 27) !== '010') continue;                 // só mercado à vista, lote padrão
    const tk = linha.slice(12, 24).trim();
    if (!/^[A-Z]{4}\d{1,2}$/.test(tk)) continue;
    const fator = parseInt(linha.slice(210, 217), 10) || 1;
    const p = parseInt(linha.slice(108, 121), 10) / 100 / fator;
    if (!(p > 0)) continue;
    precos[tk] = Math.round(p * 10000) / 10000;
    const d = linha.slice(2, 10);
    if (/^\d{8}$/.test(d)) data = d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
  }
  return { data, precos };
}
export function urlCotahistDia(d) {
  const dd = String(d.getUTCDate()).padStart(2, '0'), mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return (process.env.COTAHIST_BASE || 'https://bvmf.bmfbovespa.com.br/InstDados/SerHist/') + 'COTAHIST_D' + dd + mm + d.getUTCFullYear() + '.ZIP';
}

/* ---------- CVM: CSV com ';' em latin1 ---------- */
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
export function lerCsv(buf) {
  const linhas = buf.toString('latin1').split(/\r?\n/).filter(Boolean);
  const cab = linhas.shift().split(';').map(norm);
  return linhas.map((l) => { const c = l.split(';'), o = {}; cab.forEach((k, i) => { o[k] = (c[i] || '').trim(); }); return o; });
}
const achar = (o, re) => { const k = Object.keys(o).find((x) => re.test(x)); return k ? o[k] : ''; };
const num = (s) => { s = String(s).trim(); const v = parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); return Number.isFinite(v) ? v : NaN; };
const escala = (e) => (/MIL/.test(norm(e)) ? 1000 : 1);

/* devolve {TK: {lpa, vpa, ref}} a partir dos CSV da CVM (DFP: DRE, BPP, composição do capital; FCA: valores mobiliários) */
export function lerFundamentos({ dre, bpp, capital, fca, dfc = [] }) {
  // mais recente por empresa
  const ultimo = (linhas) => {
    const m = new Map();
    linhas.forEach((r) => {
      const k = r.CNPJ_CIA, v = (r.DT_REFER || '') + '|' + String(r.VERSAO || '0').padStart(3, '0');
      if (!m.has(k) || m.get(k).v < v) m.set(k, { v, d: r.DT_REFER });
    });
    return m;
  };
  const ult = ultimo(dre), lpa = new Map(), ref = new Map();
  const lpaAnt = new Map();
  dre.forEach((r) => {
    if (norm(r.ORDEM_EXERC) === 'PENULTIMO') {
      const c = r.CD_CONTA || '', val = num(r.VL_CONTA);
      if ((c === '3.99.01.01' || c === '3.99.01.02') && Number.isFinite(val)) { const o = lpaAnt.get(r.CNPJ_CIA) || {}; o[c === '3.99.01.01' ? 'ON' : 'PN'] = val; lpaAnt.set(r.CNPJ_CIA, o); }
      return;
    }
    if (norm(r.ORDEM_EXERC) !== 'ULTIMO') return;
    const v = (r.DT_REFER || '') + '|' + String(r.VERSAO || '0').padStart(3, '0');
    if (!ult.has(r.CNPJ_CIA) || ult.get(r.CNPJ_CIA).v !== v) return;
    const c = r.CD_CONTA || '';
    if (c !== '3.99.01.01' && c !== '3.99.01.02' && c !== '3.99.01') return;
    const val = num(r.VL_CONTA); if (!Number.isFinite(val)) return;
    const o = lpa.get(r.CNPJ_CIA) || {};
    const classe = c === '3.99.01.01' ? 'ON' : c === '3.99.01.02' ? 'PN' : 'ON';
    o[classe] = val; lpa.set(r.CNPJ_CIA, o); ref.set(r.CNPJ_CIA, r.DT_REFER);
  });
  const ultB = ultimo(bpp), pl = new Map();
  bpp.forEach((r) => {
    if (norm(r.ORDEM_EXERC) !== 'ULTIMO') return;
    const v = (r.DT_REFER || '') + '|' + String(r.VERSAO || '0').padStart(3, '0');
    if (!ultB.has(r.CNPJ_CIA) || ultB.get(r.CNPJ_CIA).v !== v) return;
    const c = r.CD_CONTA || '', val = num(r.VL_CONTA) * escala(r.ESCALA_MOEDA);
    if (!Number.isFinite(val)) return;
    const o = pl.get(r.CNPJ_CIA) || {};
    if (c === '2.03') o.total = val;
    if (c === '2.03.09') o.nc = val;
    pl.set(r.CNPJ_CIA, o);
  });
  /* dividendos e JCP pagos no último exercício (demonstração do fluxo de caixa, grupo 6.03), valor total da empresa */
  const ultD = ultimo(dfc), divPago = new Map();
  dfc.forEach((r) => {
    if (norm(r.ORDEM_EXERC) !== 'ULTIMO') return;
    const v = (r.DT_REFER || '') + '|' + String(r.VERSAO || '0').padStart(3, '0');
    if (!ultD.has(r.CNPJ_CIA) || ultD.get(r.CNPJ_CIA).v !== v) return;
    if (!/^6\.03\./.test(r.CD_CONTA || '') || !/DIVIDENDO|JUROS SOBRE O CAPITAL|JCP/.test(norm(r.DS_CONTA))) return;
    if (/RECEB/.test(norm(r.DS_CONTA))) return;
    const val = num(r.VL_CONTA) * escala(r.ESCALA_MOEDA); if (!Number.isFinite(val)) return;
    divPago.set(r.CNPJ_CIA, (divPago.get(r.CNPJ_CIA) || 0) + Math.abs(val));
  });
  const acoes = new Map(), ultC = ultimo(capital);
  capital.forEach((r) => {
    const v = (r.DT_REFER || '') + '|' + String(r.VERSAO || '0').padStart(3, '0');
    if (!ultC.has(r.CNPJ_CIA) || ultC.get(r.CNPJ_CIA).v !== v) return;
    const tot = num(achar(r, /^QT_ACAO_TOTAL.*INTEGR/)), tes = num(achar(r, /^QT_ACAO_TOTAL.*TESOURO/)) || 0;
    if (Number.isFinite(tot) && tot > 0) acoes.set(r.CNPJ_CIA, tot - tes);
  });
  // código de negociação por empresa e classe
  const out = {};
  const vistos = new Map();
  fca.forEach((r) => {
    const cnpj = r.CNPJ_COMPANHIA || r.CNPJ_CIA, tipo = norm(achar(r, /^VALOR_MOBILIARIO$/)), cod = achar(r, /^CODIGO_NEGOCIACAO$/);
    if (!cnpj || !cod) return;
    const classe = /ORDIN/.test(tipo) ? 'ON' : /PREFER/.test(tipo) ? 'PN' : '';
    if (!classe) return;
    const dt = achar(r, /^DATA_REFERENCIA$/) + '|' + String(achar(r, /^VERSAO$/) || '0').padStart(3, '0');
    (cod.match(/[A-Z]{4}\d{1,2}/g) || []).forEach((tk) => {
      const k = cnpj + '|' + tk;
      if (!vistos.has(k) || vistos.get(k) < dt) { vistos.set(k, dt); out[tk] = { cnpj, classe }; }
    });
  });
  const itens = {};
  Object.keys(out).forEach((tk) => {
    const { cnpj, classe } = out[tk], l = lpa.get(cnpj), p = pl.get(cnpj), n = acoes.get(cnpj);
    if (!l && !(p && n)) return;
    const item = {}, la = lpaAnt.get(cnpj);
    const lv = l ? (l[classe] != null ? l[classe] : (l.ON != null ? l.ON : l.PN)) : null;
    if (lv != null && Number.isFinite(lv)) item.lpa = Math.round(lv * 10000) / 10000;
    if (p && p.total != null && n > 0) { const base = p.total - (p.nc || 0); if (base > 0) item.vpa = Math.round(base / n * 10000) / 10000; }
    if (n > 0 && divPago.get(cnpj) > 0) item.dpa = Math.round(divPago.get(cnpj) / n * 10000) / 10000;
    if (item.lpa > 0 && la) { const lp = la[classe] != null ? la[classe] : (la.ON != null ? la.ON : la.PN); if (lp > 0) { const g = (item.lpa / lp - 1) * 100; item.cresc = Math.round(Math.min(15, Math.max(0, g)) * 10) / 10; } }
    if (item.lpa != null || item.vpa != null) { item.ref = ref.get(cnpj) || ''; itens[tk] = item; }
  });
  return itens;
}
