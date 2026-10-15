require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const KALSHI = "https://external-api.kalshi.com/trade-api/v2";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const STOP = new Set([
  "will","the","a","an","in","on","of","to","be","is","are","by","at",
  "for","and","or","before","after","end","yes","no","market","win",
  "wins","than","more","less","this","that","which","who","what","when"
]);

function terms(s) {
  return new Set(
    String(s || "").toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w))
  );
}

function overlap(a, b) {
  const A = terms(a), B = terms(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

async function fetchKalshi() {
  const out = [];
  let cursor = "";
  let primoLog = true;

  for (let i = 0; i < 10; i++) {
    const url = `${KALSHI}/markets?limit=1000`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const r = await fetch(url);
    if (!r.ok) {
      console.error(`[kalshi] HTTP ${r.status} su ${url}`);
      break;
    }
    const j = await r.json();

    if (primoLog) {
      console.log(`[kalshi] chiavi risposta: ${Object.keys(j).join(",")}`);
      const arr = j.markets || j.data || [];
      console.log(`[kalshi] primo giro: ${arr.length} mercati`);
      if (arr[0]) console.log(`[kalshi] campi: ${Object.keys(arr[0]).slice(0, 30).join(",")}`);
      primoLog = false;
    }

    const page = j.markets || j.data || [];
    out.push(...page);
    cursor = j.cursor || "";
    if (!cursor || page.length === 0) break;
  }

  console.log(`[kalshi] scaricati ${out.length} grezzi`);

  const mapped = out.map(m => ({
    src: "kalshi",
    id: m.ticker,
    title: m.title || m.yes_sub_title || m.ticker,
    yesAsk: parseFloat(m.yes_ask_dollars),
    noAsk: parseFloat(m.no_ask_dollars),
    vol: parseFloat(m.volume_fp || 0),
    closeTime: m.close_time,
    status: m.status,
    rules: (m.rules_primary || "").slice(0, 400),
  }));

  const aperti = mapped.filter(m => m.status === "open" || m.status === "active" || !m.status);
  console.log(`[kalshi] aperti: ${aperti.length}`);

  const conPrezzi = aperti.filter(m => isFinite(m.yesAsk) && isFinite(m.noAsk));
  console.log(`[kalshi] con prezzi validi: ${conPrezzi.length}`);

  const passati = conPrezzi.filter(m => m.yesAsk > 0.02 && m.yesAsk < 0.98);
  console.log(`[kalshi] dopo filtro prezzo: ${passati.length}`);

  return passati;
}

async function fetchPolymarket() {
  const out = [];
  let primoLog = true;

  for (let off = 0; off < 5000; off += 500) {
    const r = await fetch(`${GAMMA}/markets?closed=false&active=true&limit=500&offset=${off}`);
    if (!r.ok) { console.error(`[poly] HTTP ${r.status}`); break; }
    const j = await r.json();
    const page = Array.isArray(j) ? j : j.data || [];

    if (primoLog && page[0]) {
      console.log(`[poly] campi: ${Object.keys(page[0]).slice(0, 30).join(",")}`);
      primoLog = false;
    }

    console.log(`[poly] offset ${off}: ${page.length} grezzi`);
    if (!page.length) break;
    out.push(...page);
    if (page.length < 500) break;
  }

  console.log(`[poly] scaricati ${out.length} grezzi`);

  const aperti = out.filter(m => m.acceptingOrders === true);
  console.log(`[poly] aperti: ${aperti.length}`);

  const mapped = aperti.map(m => {
    let tok = [];
    try { tok = JSON.parse(m.clobTokenIds || "[]"); } catch {}
    return {
      src: "poly",
      id: m.conditionId,
      title: m.question,
      yesToken: tok[0],
      noToken: tok[1],
      vol: parseFloat(m.volumeNum || 0),
    };
  });

  const conToken = mapped.filter(m => m.yesToken && m.noToken);
  console.log(`[poly] con token: ${conToken.length}`);

  return conToken;
}

async function polyAsk(tokenId) {
  if (!tokenId) return null;
  try {
    const r = await fetch(`${CLOB}/book?token_id=${tokenId}`);
    if (!r.ok) return null;
    const j = await r.json();
    const asks = (j.asks || [])
      .map(a => parseFloat(a.price))
      .filter(p => isFinite(p) && p > 0 && p < 1);
    return asks.length ? Math.min(...asks) : null;
  } catch {
    return null;
  }
}

async function scanOnce() {
  const [k, p] = await Promise.all([fetchKalshi(), fetchPolymarket()]);
  console.log(`[scan] Kalshi utilizzabili ${k.length} | Polymarket utilizzabili ${p.length}`);

  const hits = [];
  let accoppiate = 0;

  for (const km of k) {
    let best = null, bestScore = 0;
    for (const pm of p) {
      const s = overlap(km.title, pm.title);
      if (s > bestScore) { bestScore = s; best = pm; }
    }
    if (!best || bestScore < 0.6) continue;
    accoppiate++;

    const [pYes, pNo] = await Promise.all([
      polyAsk(best.yesToken),
      polyAsk(best.noToken),
    ]);
    if (pYes === null || pNo === null) continue;

    const costA = km.yesAsk + pNo;
    const costB = km.noAsk + pYes;
    const cost = Math.min(costA, costB);
    const leg = costA <= costB ? "K_YES + P_NO" : "K_NO + P_YES";

    if (cost < 1.0) {
      hits.push({
        edge: 1 - cost,
        leg,
        overlap: Math.round(bestScore * 100),
        kalshi_id: km.id,
        kalshi_title: km.title,
        kalshi_rules: km.rules,
        kalshi_vol: km.vol,
        kalshi_close: km.closeTime,
        poly_id: best.id,
        poly_title: best.title,
        poly_vol: best.vol,
        cost: +cost.toFixed(4),
      });
    }
  }

  console.log(`[scan] coppie accoppiate (soglia 60%): ${accoppiate}`);
  hits.sort((a, b) => b.edge - a.edge);
  const top = hits.slice(0, 100);
  console.log(`[scan] coppie con somma < 1.00: ${hits.length}`);

  if (top.length) {
    const rows = top.map(h => ({
      category: "cross-platform",
      event_title: null,
      market_title: `K: ${h.kalshi_title} || P: ${h.poly_title}`.slice(0, 900),
      condition_id: h.poly_id,
      signal_type: h.leg,
      detail: [
        `edge=${(h.edge * 100).toFixed(2)}%`,
        `cost=${h.cost}`,
        `overlap=${h.overlap}%`,
        `kalshi_ticker=${h.kalshi_id}`,
        `kalshi_close=${h.kalshi_close}`,
        `kalshi_vol=${h.kalshi_vol}`,
        `poly_vol=${h.poly_vol}`,
        `KALSHI_RULES: ${h.kalshi_rules}`,
      ].join(" | "),
      price_sum: h.cost,
      edge: +h.edge.toFixed(4),
      spread: null,
      capital_needed: 0,
      liquidity: h.kalshi_vol,
      live: h.edge > 0.02,
    }));

    const { error } = await supabase.from("signals").insert(rows);
    if (error) throw new Error(`insert: ${error.message}`);
    console.log(`[scan] scritte ${rows.length} righe`);
  } else {
    console.log(`[scan] nessuna riga da scrivere`);
  }
}

(async () => {
  try { await scanOnce(); }
  catch (e) { console.error("errore:", e); process.exit(1); }
})();
