// fetch-data.js — GitHub Actions, every 3h. Full multi-source, resilient.
// Each source is isolated: a failure keeps the last-good value, never blanks the app.
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const FMP = process.env.FMP_API_KEY;
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const PREV_URL = process.env.PREV_DATA_URL;
const MFX_EMAIL = process.env.MYFXBOOK_EMAIL;     // optional: enables live retail
const MFX_PASS = process.env.MYFXBOOK_PASSWORD;   // optional
const NEWS_ON = process.env.DISABLE_NEWS !== "1"; // set DISABLE_NEWS=1 to skip web_search (saves cost)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url, opt) {
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error(r.status + " " + url.split("?")[0]);
  return r.json();
}
async function withRetry(fn, n = 2) {
  let last;
  for (let i = 0; i <= n; i++) {
    try { return await fn(); }
    catch (e) { last = e; if (String(e.message).includes("429")) break; if (i < n) await sleep(1000 * (i + 1)); }
  }
  throw last;
}
async function loadPrev() {
  if (PREV_URL) { try { const r = await fetch(PREV_URL + "?t=" + Date.now()); if (r.ok) return await r.json(); } catch {} }
  try { if (existsSync("data.json")) return JSON.parse(readFileSync("data.json", "utf8")); } catch {}
  return {};
}

/* ---------- FMP: prices/gold/index (single-symbol, free-tier safe) ---------- */
const FX = ["EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "USDCHF", "USDCAD"];
async function fmpQuote(sym) {
  const a = await getJSON(`https://financialmodelingprep.com/stable/quote?symbol=${sym}&apikey=${FMP}`);
  return Array.isArray(a) ? a[0] : a;
}
async function getPrices(errors) {
  const syms = [...FX, "GCUSD", "%5EGSPC"];
  const prices = {};
  for (const s of syms) {
    try {
      const q = await withRetry(() => fmpQuote(s));
      if (q) {
        const key = s === "%5EGSPC" ? "GSPC" : s;
        prices[key] = { price: q.price, chg: (q.changePercentage ?? q.changesPercentage), low: q.dayLow, high: q.dayHigh, ma50: q.priceAvg50, ma200: q.priceAvg200, yearHigh: q.yearHigh, yearLow: q.yearLow };
      }
    } catch (e) { errors.push("FMP " + s + ": " + e.message); }
    await sleep(300); // spacing to respect free-tier limits
  }
  if (prices.EURUSD && prices.USDJPY) {
    const chg = (typeof prices.EURUSD.chg === "number" && typeof prices.USDJPY.chg === "number") ? +(prices.EURUSD.chg + prices.USDJPY.chg).toFixed(2) : null;
    prices.EURJPY = { price: +(prices.EURUSD.price * prices.USDJPY.price).toFixed(2), chg, derived: true };
  }
  if (prices.GBPUSD && prices.USDJPY) {
    const chg = (typeof prices.GBPUSD.chg === "number" && typeof prices.USDJPY.chg === "number") ? +(prices.GBPUSD.chg + prices.USDJPY.chg).toFixed(2) : null;
    prices.GBPJPY = { price: +(prices.GBPUSD.price * prices.USDJPY.price).toFixed(2), chg, derived: true };
  }
  return prices;
}
/* ---------- FMP: 30-day closes for sparklines (isolated; absence is fine) ---------- */
async function getSparks(errors) {
  if (!FMP) return null;
  const d2 = (d) => d.toISOString().slice(0, 10);
  const to = new Date(), from = new Date(Date.now() - 46 * 864e5);
  const syms = [...FX, "GCUSD", "%5EGSPC"];
  const out = {};
  for (const s of syms) {
    try {
      const res = await withRetry(() => getJSON(`https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${s}&from=${d2(from)}&to=${d2(to)}&apikey=${FMP}`));
      const rows = Array.isArray(res) ? res : (res && res.historical) || [];
      const pts = rows
        .map((r) => ({ d: r.date, c: Number(r.price ?? r.close ?? r.adjClose) }))
        .filter((p) => p.d && isFinite(p.c))
        .sort((a, b) => (a.d < b.d ? -1 : 1))
        .slice(-32);
      if (pts.length >= 5) out[s === "%5EGSPC" ? "GSPC" : s] = pts;
    } catch (e) { errors.push("spark " + s + ": " + e.message); }
    await sleep(300);
  }
  const map = (k) => { const m = {}; (out[k] || []).forEach((p) => (m[p.d] = p.c)); return m; };
  const cross = (a, b) => Object.keys(a).filter((d) => b[d]).sort().map((d) => ({ d, c: a[d] * b[d] })).slice(-32);
  const eu = map("EURUSD"), uj = map("USDJPY"), gu = map("GBPUSD");
  const ej = cross(eu, uj); if (ej.length >= 5) out.EURJPY = ej;
  const gj = cross(gu, uj); if (gj.length >= 5) out.GBPJPY = gj;
  if (!Object.keys(out).length) return null;
  const flat = {};
  for (const [k, v] of Object.entries(out)) flat[k] = v.map((p) => +(+p.c).toPrecision(7));
  return flat;
}

function calcStrength(p) {
  const vsUSD = { USD: 0, EUR: p.EURUSD?.chg, GBP: p.GBPUSD?.chg, AUD: p.AUDUSD?.chg, JPY: p.USDJPY ? -p.USDJPY.chg : undefined, CHF: p.USDCHF ? -p.USDCHF.chg : undefined, CAD: p.USDCAD ? -p.USDCAD.chg : undefined };
  const vals = Object.values(vsUSD).filter((v) => typeof v === "number");
  if (!vals.length) return [];
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Object.entries(vsUSD).filter(([, v]) => typeof v === "number").map(([ccy, v]) => ({ ccy, score: +(v - mean).toFixed(2) })).sort((a, b) => b.score - a.score);
}

/* ---------- FMP: treasury yields ---------- */
async function getYields() {
  const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 12 * 864e5).toISOString().slice(0, 10);
  const a = await withRetry(() => getJSON(`https://financialmodelingprep.com/stable/treasury-rates?from=${from}&to=${to}&apikey=${FMP}`));
  if (a && a[0]) return { y2: a[0].year2, y10: a[0].year10, date: a[0].date };
  throw new Error("no rows");
}

/* ---------- CFTC: COT (official API, parallel) ---------- */
const COTDEF = { GOLD: "%GOLD - COMMODITY EXCHANGE%", EUR: "%EURO FX -%", JPY: "%JAPANESE YEN -%", GBP: "%BRITISH POUND%", AUD: "%AUSTRALIAN DOLLAR%", CAD: "%CANADIAN DOLLAR%" };
async function getCOT(errors, prevCot) {
  const cot = { ...(prevCot || {}) };
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

/* ---------- Myfxbook: retail positions (optional, needs free login) ---------- */
const RETAIL_PAIRS = ["XAUUSD", "EURUSD", "USDJPY", "EURJPY", "GBPUSD", "AUDUSD", "USDCAD", "GBPJPY"];
async function getRetail(errors) {
  if (!MFX_EMAIL || !MFX_PASS) return null; // not configured -> AI estimate used instead
  try {
    const login = await getJSON(`https://www.myfxbook.com/api/login.json?email=${encodeURIComponent(MFX_EMAIL)}&password=${encodeURIComponent(MFX_PASS)}`);
    if (!login || login.error || !login.session) throw new Error("login " + (login && login.message || "failed"));
    const out = await getJSON(`https://www.myfxbook.com/api/get-community-outlook.json?session=${encodeURIComponent(login.session)}`);
    const syms = (out && out.symbols) || [];
    const retail = {};
    for (const s of syms) {
      const name = (s.name || "").toUpperCase();
      if (RETAIL_PAIRS.includes(name)) {
        const sp = Math.round(+(s.shortPercentage ?? s.shortPositionsPercentage ?? 0));
        const lp = Math.round(+(s.longPercentage ?? s.longPositionsPercentage ?? 0));
        if (sp || lp) retail[name] = { s: sp, l: lp };
      }
    }
    return Object.keys(retail).length ? retail : null;
  } catch (e) { errors.push("Myfxbook: " + e.message); return null; }
}

/* ---------- Anthropic helpers ---------- */
async function callAnthropic(payload, signal) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(payload), signal
  });
  return r.json();
}
function repairJSON(s) {
  // isolate from first brace
  const first = s.indexOf("{");
  if (first > 0) s = s.slice(first);
  // if it already parses, done
  try { JSON.parse(s.replace(/,\s*([\]}])/g, "$1")); return s.replace(/,\s*([\]}])/g, "$1"); } catch {}
  // walk and track structure, ignoring string contents
  const stack = [];
  let inStr = false, escaped = false, lastValidEnd = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") { stack.pop(); if (stack.length === 0) lastValidEnd = i; }
  }
  // if a complete top-level object closed cleanly, take it
  if (lastValidEnd > 0 && !inStr) { const cut = s.slice(0, lastValidEnd + 1); try { JSON.parse(cut); return cut; } catch {} }
  // otherwise: truncated. Close open string, drop trailing partial token, balance brackets.
  let t = s;
  if (inStr) t += '"';
  // remove a dangling ": or , at the very end (incomplete key/value)
  t = t.replace(/[,:]\s*$/, "");
  // remove a trailing incomplete "key" with no value
  t = t.replace(/,\s*"[^"]*"\s*$/, "");
  t = t.replace(/,\s*([\]}])/g, "$1");
  while (stack.length) t += stack.pop();
  try { JSON.parse(t); return t; } catch {}
  // last resort: original isolated string
  return s.replace(/,\s*([\]}])/g, "$1");
}

/* ---------- News/bank via web_search (separate prose call; pause_turn handled) ---------- */
async function getNews(errors) {
  if (!ANTHROPIC || !NEWS_ON) return null;
  const today = new Date().toISOString().slice(0, 10);
  let messages = [{ role: "user", content: `本日(${today})の為替・ゴールド市場について、日本語で簡潔に要約してください。重視: USDJPY/EURUSD/EURJPY/GBPUSD/XAUUSD。含めるもの: (1)主要ニュース・値動きの背景, (2)銀行・調査機関の見解(三菱UFJ/MUFG・三井住友/SMBC・みずほ・InvestingLive等), (3)直近の重要経済指標の予定(米CPI等)と通過済みの結果, (4)ドル円の介入観測。各項目に出所名を併記。箇条書きで300〜500字程度。` }];
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 100000);
  try {
    for (let i = 0; i < 5; i++) {
      const data = await callAnthropic({ model: MODEL, max_tokens: 1500, messages, tools }, ctrl.signal);
      if (data.type === "error") { errors.push("News: " + ((data.error && data.error.message) || "error")); return null; }
      messages.push({ role: "assistant", content: data.content });
      if (data.stop_reason === "pause_turn") continue; // continue the tool turn
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return text || null;
    }
    return null;
  } catch (e) { errors.push("News: " + (e.name === "AbortError" ? "timeout" : e.message)); return null; }
  finally { clearTimeout(t); }
}

/* ---------- Structured analysis (no tools -> clean JSON) ---------- */
async function getAnalysis(out, news, errors) {
  if (!ANTHROPIC) { errors.push("ANTHROPIC_API_KEY 未設定"); return null; }
  const prompt = `あなたはFX/ゴールドのトレードデスク・アナリストです。以下の確定数値とニュース要約を根拠に、日本語で判断材料をまとめてください。
価格:${JSON.stringify(out.prices)} 利回り:${JSON.stringify(out.yields)} 強弱:${JSON.stringify(out.strength)} COT:${JSON.stringify(out.cot)}
ニュース要約:${news ? news.slice(0, 2000) : "（なし）"}
対象8銘柄と各特徴（必ず特徴とファンダを踏まえて分析）:
- XAUUSD ゴールド: 実質金利・有事/地政学・ドル逆相関。
- EURUSD: 最大流動性、対ドル基軸。ECB/独経済・米金利差。
- USDJPY: 日米金利差・リスク選好・介入警戒(年初来高値圏)。
- EURJPY: リスク選好クロス(EURUSD×USDJPY)。
- GBPUSD: 英BOE金利・対ドル。
- AUDUSD: 資源国通貨・中国景気・リスク選好の代理。豪準備銀/コモディティ。
- USDCAD: 原油相関(逆相関:原油高→CAD高→USDCAD安)・北米指標。
- GBPJPY: 高ボラティリティ、リスク選好バロメーター(GBPUSD×USDJPY)。
手法=1H/15M/5M・エリオット第3波・セッション・ティア別。
news欄とbank欄はニュース要約を反映（無い項目は数値・水準・移動平均・利回り・COTからの地合いを書き、不明は"要確認"）。bank.summaryはニュース全体を2〜3文に凝縮。bank.banksは各機関(MUFG/三井住友/みずほ/野村/Goldman/OANDA/外為どっとコム等)の見解を1社1文で要約（取得できた範囲のみ、無ければ[]）。各ペアのcotReadは該当通貨のCOTと価格の整合/乖離に言及。retailは要約や一般傾向からの推定（数値は後で実測上書きの場合あり）。
eventsは「本日(JST)」に予定される主要経済指標・イベントを時刻順に最大6件。各要素は{"time":"HH:MM","name":"指標名(国)","imp":"high|mid|low"}。timeは日本時間のHH:MM（時刻不明はtimeを""にしてnameに記載）。ニュース要約に直近の予定が無ければ既知の定例を推測で埋めず確実なものだけ。該当が無ければ[]。過去日のイベントは含めない。
xpostはX(旧Twitter)投稿用の本日の概況本文。overviewを基に、移動平均・50日線/200日線・RSI等の細かいテクニカルは書かず、マクロ・金利・地政学・主要通貨/金の地合いに絞る。日本語で2〜4文、全体180字以内、ハッシュタグや絵文字や日付見出しは付けない（本文のみ）。
重要: 出力はJSONオブジェクトだけ（全体で日本語4500字以内）。前置き・Markdown・コードフェンス・コメントは付けない。文字列中に改行やダブルクォートを入れない。各文は簡潔に1〜2文。スキーマ:
{"overview":"","xpost":"","strengthRead":"","riskMacro":"","scenario":"","cotReading":"","events":[{"time":"","name":"","imp":""}],"retail":{"XAUUSD":{"s":59,"l":41,"note":""},"EURUSD":{},"USDJPY":{},"EURJPY":{},"GBPUSD":{},"AUDUSD":{},"USDCAD":{},"GBPJPY":{}},"bank":{"summary":"","banks":[{"name":"","view":""}],"drivers":"","intervention":"","risk":"","rangeUSDJPY":"","rangeEURJPY":""},"pairs":{"XAUUSD":{"bias":"","trend":"","news":"","strategy":"","levels":"","cotRead":"","risk":""},"EURUSD":{},"USDJPY":{},"EURJPY":{},"GBPUSD":{},"AUDUSD":{},"USDCAD":{},"GBPJPY":{}}}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 180000);
  try {
    let lastErr = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const data = await callAnthropic({ model: MODEL, max_tokens: 8000, messages: [{ role: "user", content: prompt }] }, ctrl.signal);
        if (data.type === "error") {
          const msg = (data.error && data.error.message) || "error";
          lastErr = msg;
          // rate-limit / overloaded -> wait and retry
          if (/rate|overload|429|529/i.test(msg) && attempt < 3) { await sleep(20000); continue; }
          errors.push("Anthropic: " + msg); return null;
        }
        const truncated = data.stop_reason === "max_tokens";
        let text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
        try {
          const parsed = JSON.parse(repairJSON(text));
          if (truncated) errors.push("Anthropic: 出力上限到達→部分補修で採用");
          return parsed;
        } catch (e) {
          lastErr = "parse " + e.message;
          if (attempt < 3) { await sleep(3000); continue; }
        }
      } catch (e) {
        lastErr = e.name === "AbortError" ? "timeout" : e.message;
        if (attempt < 3 && lastErr !== "timeout") { await sleep(5000); continue; }
        break;
      }
    }
    errors.push("Anthropic: " + lastErr + "（3回試行後）");
    return null;
  } finally { clearTimeout(t); }
}

/* ---------- main ---------- */
const prev = await loadPrev();
const now = new Date().toISOString();
const errors = [];
const out = {
  updated: now,
  prices: prev.prices || {}, yields: prev.yields || {}, strength: prev.strength || [],
  cot: prev.cot || {}, analysis: prev.analysis || null, spark: prev.spark || null,
  news: prev.news || null, freshness: prev.freshness || {}, errors: []
};

// 1) prices + strength
try {
  const p = await getPrices(errors);
  if (Object.keys(p).length >= 4) { out.prices = p; out.strength = calcStrength(p); out.freshness.prices = now; }
  else errors.push("prices: 取得不足→前回値を維持");
} catch (e) { errors.push("prices: " + e.message + "→前回値を維持"); }

// 1b) 30-day closes for sparklines (optional layer)
try {
  const sp = await getSparks(errors);
  if (sp) { out.spark = sp; out.freshness.spark = now; }
} catch (e) { errors.push("spark: " + e.message + "→前回値を維持"); }

// 2) yields
try { out.yields = await getYields(); out.freshness.yields = now; }
catch (e) { errors.push("treasury: " + e.message + "→前回値を維持"); }

// 3) COT
try { out.cot = await getCOT(errors, out.cot); out.freshness.cot = now; }
catch (e) { errors.push("cot: " + e.message + "→前回値を維持"); }

// 4) retail (optional live) + 5) news (web_search) in parallel
const [retail, news] = await Promise.all([getRetail(errors), getNews(errors)]);
if (news) { out.news = news; out.freshness.news = now; }

// pace AI calls: keep news + analysis in separate minutes (input-token/min rate limit)
if (news && ANTHROPIC) await sleep(65000);

// 6) structured analysis (uses numbers + news)
const a = await getAnalysis(out, out.news, errors);
const todayJST = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
if (a) {
  a.asof = todayJST;
  a.stale = false;
  out.analysis = a;
  out.freshness.analysis = now;
} else if (out.analysis) {
  out.analysis.stale = true;          // prior analysis retained, not regenerated today
  out.analysis.staleAsof = todayJST;  // the date on which regeneration failed
  errors.push("analysis: 生成失敗→前回分析を表示中（数値は最新）");
}

// 7) overlay REAL retail numbers on top of analysis (if fetched live)
if (retail && out.analysis) {
  out.analysis.retail = out.analysis.retail || {};
  for (const [pair, v] of Object.entries(retail)) {
    const note = (out.analysis.retail[pair] && out.analysis.retail[pair].note) || "";
    out.analysis.retail[pair] = { s: v.s, l: v.l, note };
  }
  out.freshness.retail = now;
}

out.errors = errors;
writeFileSync("data.json", JSON.stringify(out, null, 2));
console.log("Wrote data.json", { errors });
