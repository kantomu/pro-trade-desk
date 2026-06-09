// fetch-data.js — runs in GitHub Actions every 3h.
// RESILIENCE: starts from last-good data and only overwrites a section when its
// fetch succeeds. One failing source never blanks the app. Per-source freshness recorded.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

const FMP = process.env.FMP_API_KEY;
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const PREV_URL = process.env.PREV_DATA_URL; // live data.json (last-good across runs)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url, opt) {
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error(r.status + " " + url.split("?")[0]);
  return r.json();
}
async function withRetry(fn, n = 2) {
  let last;
  for (let i = 0; i <= n; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < n) await sleep(700 * (i + 1)); }
  }
  throw last;
}

// last-good baseline: prefer the live deployed file, fall back to bundled seed
async function loadPrev() {
  if (PREV_URL) { try { const r = await fetch(PREV_URL + "?t=" + Date.now()); if (r.ok) return await r.json(); } catch {} }
  try { if (existsSync("public/data.json")) return JSON.parse(readFileSync("public/data.json", "utf8")); } catch {}
  return {};
}

const FX = ["EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "USDCHF", "USDCAD"];
async function fmpQuote(sym) {
  const a = await getJSON(`https://financialmodelingprep.com/stable/quote?symbol=${sym}&apikey=${FMP}`);
  return Array.isArray(a) ? a[0] : a;
}
async function getPrices(errors) {
  const syms = [...FX, "GCUSD", "%5EGSPC"];
  const res = await Promise.all(syms.map(async (s) => {
    try { return [s, await withRetry(() => fmpQuote(s))]; } catch (e) { errors.push("FMP " + s + ": " + e.message); return [s, null]; }
  }));
  const prices = {};
  for (const [s, q] of res) {
    if (!q) continue;
    const key = s === "%5EGSPC" ? "GSPC" : s;
    prices[key] = { price: q.price, chg: (q.changePercentage ?? q.changesPercentage), low: q.dayLow, high: q.dayHigh, ma50: q.priceAvg50, ma200: q.priceAvg200, yearHigh: q.yearHigh, yearLow: q.yearLow };
  }
  if (prices.EURUSD && prices.USDJPY) prices.EURJPY = { price: +(prices.EURUSD.price * prices.USDJPY.price).toFixed(2), derived: true };
  return prices;
}
function calcStrength(p) {
  const vsUSD = { USD: 0, EUR: p.EURUSD?.chg, GBP: p.GBPUSD?.chg, AUD: p.AUDUSD?.chg, JPY: p.USDJPY ? -p.USDJPY.chg : undefined, CHF: p.USDCHF ? -p.USDCHF.chg : undefined, CAD: p.USDCAD ? -p.USDCAD.chg : undefined };
  const vals = Object.values(vsUSD).filter((v) => typeof v === "number");
  if (!vals.length) return [];
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Object.entries(vsUSD).filter(([, v]) => typeof v === "number").map(([ccy, v]) => ({ ccy, score: +(v - mean).toFixed(2) })).sort((a, b) => b.score - a.score);
}
async function getYields() {
  const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 12 * 864e5).toISOString().slice(0, 10);
  const a = await withRetry(() => getJSON(`https://financialmodelingprep.com/stable/treasury-rates?from=${from}&to=${to}&apikey=${FMP}`));
  if (a && a[0]) return { y2: a[0].year2, y10: a[0].year10, date: a[0].date };
  throw new Error("no rows");
}
const COTDEF = { GOLD: "%GOLD - COMMODITY EXCHANGE%", EUR: "%EURO FX -%", JPY: "%JAPANESE YEN -%", GBP: "%BRITISH POUND%" };
async function getCOT(errors, prevCot) {
  const cot = { ...(prevCot || {}) }; // keep prior per-contract on individual failure
  await Promise.all(Object.entries(COTDEF).map(async ([k, like]) => {
    try {
      const where = encodeURIComponent(`upper(market_and_exchange_names) like '${like}'`);
      const url = `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=${where}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=2&$select=report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all`;
      const rows = await withRetry(() => getJSON(url));
      if (!rows || !rows.length) return;
      const L = +rows[0].noncomm_positions_long_all, S = +rows[0].noncomm_positions_short_all, net = L - S;
      let chg = null;
      if (rows[1] && rows[1].report_date_as_yyyy_mm_dd !== rows[0].report_date_as_yyyy_mm_dd) chg = net - (+rows[1].noncomm_positions_long_all - +rows[1].noncomm_positions_short_all);
      cot[k] = { net, long: L, short: S, chg, date: (rows[0].report_date_as_yyyy_mm_dd || "").slice(0, 10) };
    } catch (e) { errors.push("COT " + k + ": " + e.message); }
  }));
  return cot;
}
async function getAnalysis(out, errors) {
  if (!ANTHROPIC) { errors.push("ANTHROPIC_API_KEY 未設定"); return null; }
  const prompt = `あなたはFX/ゴールドのトレードデスク・アナリストです。以下の確定数値（最新のライブ値）を根拠に、日本語で判断材料をまとめてください。
価格:${JSON.stringify(out.prices)} 利回り:${JSON.stringify(out.yields)} 強弱:${JSON.stringify(out.strength)} COT:${JSON.stringify(out.cot)}
対象:XAUUSD,EURUSD,USDJPY,EURJPY,GBPUSD。手法=1H/15M/5M・エリオット第3波・セッション・ティア別。
ニュースは具体的な見出しを創作せず、価格・水準・移動平均・利回り・COTから読み取れる地合いを書く（不明は"要確認"）。retailは一般的傾向の推定に留める。
**前置きやMarkdown・コードフェンスを付けず、次のスキーマのJSONのみを出力**:
{"overview":"","strengthRead":"","riskMacro":"","scenario":"","cotReading":"","retail":{"XAUUSD":{"s":59,"l":41,"note":""},"EURUSD":{},"USDJPY":{},"EURJPY":{},"GBPUSD":{}},"bank":{"drivers":"","intervention":"","risk":"","rangeUSDJPY":"","rangeEURJPY":""},"pairs":{"XAUUSD":{"bias":"","trend":"","news":"","strategy":"","levels":"","cotRead":"","risk":""},"EURUSD":{},"USDJPY":{},"EURJPY":{},"GBPUSD":{}}}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000); // Actions has no 60s cap
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, messages: [{ role: "user", content: prompt }] }),
      signal: ctrl.signal
    });
    const data = await r.json();
    if (data.type === "error") { errors.push("Anthropic: " + ((data.error && data.error.message) || "error")); return null; }
    let text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) { errors.push("Anthropic: parse " + e.message); } }
    else errors.push("Anthropic: JSON無し stop=" + (data.stop_reason || "?"));
    return null;
  } catch (e) { errors.push("Anthropic: " + (e.name === "AbortError" ? "timeout" : e.message)); return null; }
  finally { clearTimeout(t); }
}

// ---- main ----
const prev = await loadPrev();
const now = new Date().toISOString();
const errors = [];
const out = {
  updated: now,
  prices: prev.prices || {},
  yields: prev.yields || {},
  strength: prev.strength || [],
  cot: prev.cot || {},
  analysis: prev.analysis || null,
  freshness: prev.freshness || {},
  errors: []
};

// prices + strength (keep last-good if too few came back)
try {
  const p = await getPrices(errors);
  if (Object.keys(p).length >= 4) { out.prices = p; out.strength = calcStrength(p); out.freshness.prices = now; }
  else errors.push("prices: 取得不足→前回値を維持");
} catch (e) { errors.push("prices: " + e.message + "→前回値を維持"); }

// yields
try { out.yields = await getYields(); out.freshness.yields = now; }
catch (e) { errors.push("treasury: " + e.message + "→前回値を維持"); }

// cot (merge over prev; per-contract failures keep prior)
try { out.cot = await getCOT(errors, out.cot); out.freshness.cot = now; }
catch (e) { errors.push("cot: " + e.message + "→前回値を維持"); }

// analysis (built on the freshest numbers; keep prior if it fails)
const a = await getAnalysis(out, errors);
if (a) { out.analysis = a; out.freshness.analysis = now; }
else if (out.analysis) errors.push("analysis: 前回値を維持");

out.errors = errors;
mkdirSync("public", { recursive: true });
writeFileSync("public/data.json", JSON.stringify(out, null, 2));
console.log("Wrote public/data.json", { errors });
