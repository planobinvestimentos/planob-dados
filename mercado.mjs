/* Funções de mercado compartilhadas: o fechamento das 20h (telegram.mjs) e a prévia das 15h (previa.mjs) usam o MESMO código de criptomoedas.
   Fonte: CoinGecko (top 50 por valor de mercado, sem stablecoins nem versões "embrulhadas"). */
const UA = { 'User-Agent': 'PlanoB-Investimentos-aviso/1.0 (uso educacional)' };
const GECKO_MKT = process.env.COINGECKO_MARKETS_URL || 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&price_change_percentage=24h';
export const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
export const pegar = async (url) => {
  const r = await fetch(url, { headers: Object.assign({ Accept: 'application/json' }, UA), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};
export const pegarComRetry = async (url) => { try { return await pegar(url); } catch (e) { await dorme(3000); return pegar(url); } };


export const FORA = new Set(['usdt', 'usdc', 'dai', 'usde', 'fdusd', 'usds', 'busd', 'tusd', 'pyusd', 'usdd', 'usdt0', 'susde', 'usd1', 'usdtb', 'bsc-usd', 'steth', 'wsteth', 'wbtc', 'weth', 'weeth', 'wbeth', 'cbbtc', 'reth', 'cbeth', 'susds', 'bfusd', 'ousg', 'buidl', 'wtrx', 'jitosol', 'rseth']);
/* top 50 por valor de mercado, sem stablecoins nem versões "embrulhadas": 5 maiores altas e 5 maiores baixas em 24h */
export async function cripto(dol, btcSimples, quantos = 5) {
  const vazio = { btc: btcSimples ? { s: 'BTC', p: btcSimples.usd, v: btcSimples.usd_24h_change } : null, altas: [], quedas: [] };
  try {
    const j = await pegarComRetry(GECKO_MKT);
    const chg = (c) => (c.price_change_percentage_24h_in_currency != null ? c.price_change_percentage_24h_in_currency : c.price_change_percentage_24h);
    const l = (Array.isArray(j) ? j : []).filter((c) => {
      const s = String(c.symbol || '').toLowerCase();
      if (FORA.has(s) || !(c.current_price > 0) || !isFinite(chg(c))) return false;
      return !(c.current_price > 0.97 && c.current_price < 1.03 && Math.abs(chg(c)) < 1);   // parece stablecoin (preço já em dólar)
    }).map((c) => ({ s: String(c.symbol).toUpperCase(), p: c.current_price, v: chg(c) }));
    const btc = l.find((x) => x.s === 'BTC') || vazio.btc;
    return { btc, altas: [...l].filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, quantos), quedas: [...l].filter((x) => x.v < 0).sort((a, b) => a.v - b.v).slice(0, quantos) };
  } catch (e) { console.warn('aviso criptomoedas:', e.message); }
  return vazio;
}
