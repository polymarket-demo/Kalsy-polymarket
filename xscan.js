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

// ── Matching severo ──────────────────────────────────────────────────────
// Un accoppiamento è valido SOLO se TUTTE queste condizioni valgono:
//   1. data di chiusura entro 1 giorno
//   2. stesso tipo di evento (elezione, sport, cripto, economico...)
//   3. overlap parole molto alto (>= 0.80)
//   4. almeno 4 parole significative in comune
//   5. stesso numero di "entità" rilevanti (città, candidati, soglie)

const STOP = new Set([
  "will","the","a","an","in","on","of","to","be","is","are","was","were",
  "by","at","for","and","or","before","after","end","yes","no","market",
  "win","wins","than","more","less","this","that","which","who","what",
  "when","before","during","over","under","above","below","between",
  "any","all","other","new","next","last","first","second","third"
]);

// Parole che indicano LUOGHI o PERSONE plurime → se il numero non
// coincide tra le due domande, non sono lo stesso mercato.
const CITY_HINT = /\b(chicago|detroit|los angeles|atlanta|houston|new york|phoenix|philadelphia|san antonio|san diego|dallas|austin|seattle|denver|boston|miami|portland|vegas|las vegas|nashville|memphis)\b/gi;

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
  if (!A.size || !B.size) return { score: 0, comuni: 0 };
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return { score: hit / Math.min(A.size, B.size), comuni: hit };
}

// Conta le entità "geografiche" e le virgole: un mercato con 3 città
// non può accoppiarsi con uno che ne ha 1.
function entita(s) {
  const t = String(s || "");
  const citta = (t.match(CITY_HINT) || []).length;
  const virgole = (t.match(/,/g) || []).length;
  return { citta, virgole };
}

function tipoEvento(s) {
  const t = String(s || "").toLowerCase();
  if (/\b(bitcoin|btc|ethereum|eth|crypto|solana)\b/.test(t)) return "cripto";
  if (/\b(election|president|senate|congress|governor|primary|nominee|democrat|republican)\b/.test(t)) return "elezione";
  if (/\b(nba|nfl|mlb|nhl|super bowl|world series|match|game|championship|win the)\b/.test(t)) return "sport";
  if (/\b(fed|rate|inflation|cpi|gdp|unemployment|recession)\b/.test(t)) return "economia";
  if (/\b(temperature|hurricane|weather|storm)\b/.test(t)) return "meteo";
  return "altro";
}

function giorniDistanza(a, b) {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (!isFinite(da) || !isFinite(db)) return null;
  return Math.abs(da - db) / 86400000;
}

// Il giudice finale. Ritorna null se non c'è match, altrimenti il punteggio.
function matchValido(km, pm) {
  // 1. data di chiusura
  const dist = giorniDistanza(km.closeTime, pm.endDate);
  if (dist === null || dist > 1) return null;

  // 2. tipo di evento
  if (tipoEvento(km.title) !== tipoEvento(pm.title)) return null;

  // 3. + 4. testo: overlap alto E abbastanza parole in comune
  const { score, comuni } = overlap(km.title, pm.title);
  if (score < 0.80) return null;
  if (comuni < 4) return null;

  // 5. entità: stesso numero di città e di virgole
  const ek = entita(km.title), ep = entita(pm.title);
  if (ek.citta !== ep.citta) return null;
  if (Math.abs(ek.virgole - ep.virgole) > 0) return null;

  return { score, comuni, dist, tipo: tipoEvento(km.title) };
}

// ── Fetchers ─────────────────────────────────────────────────────────────

async function fetchKalshi() {
  const out = [];
  let cursor = "";
  for (let i = 0; i < 10; i++) {
    const url = `${KALSHI}/markets?limit=1000`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const r = await fetch(url);
    if (!r.ok) { console.error(`[kalshi] HTTP ${r.status}`); break; }
    const j = await r.json();
    const page = j.markets || [];
    out.push(...page);
    cursor = j.cursor || "";
    if (!cursor || !page.length) break;
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
    rules: (m.rules_primary || "").slice(0, 600),
  }));

  const aperti = mapped.filter(m => m.status === "open" || m.status === "active" || !m.status);
  const conPrezzi = aperti.filter(m => isFinite(m.yesAsk) && isFinite(m.noAsk));
  const passati = conPrezzi.filter(m =>
    (m.yesAsk > 0.01 && m.yesAsk < 0.99) ||
    (m.noAsk > 0.01 && m.noAsk < 0.99)
  );
  console.log(`[kalshi] utilizzabili: ${passati.length} (da ${aperti.length} aperti)`);
  return passati;
}

async function fetchPolymarket() {
  const out = [];
  for (let off = 0; off < 5000; off += 100) {
    const r = await fetch(`${GAMMA}/markets?closed=false&active=true&limit=100&offset=${off}`);
    if (!r.ok) { console.error(`[poly] HTTP ${r.status}`); break; }
    const j = await r.json();
    const page = Array.isArray(j) ? j : j.data || [];
    if (!page.length) break;
    out.push(...page);
    if (page.length < 100) break;
  }
  console.log(`[poly] scaricati ${out.length} grezzi`);

  const aperti = out.filter(m => m.acceptingOrders === true);
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
      endDate: m.endDate,
      description: (m.description || "").slice(0, 400),
    };
  });
  const conToken = mapped.filter(m => m.yesToken && m.noToken);
  console.log(`[poly] utilizzabili: ${conToken.length}`);
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
  } catch { return null; }
}

// ── Scan ─────────────────────────────────────────────────────────────────

async function scanOnce() {
  const [k, p] = await Promise.all([fetchKalshi(), fetchPolymarket()]);
  console.log(`[scan] Kalshi ${k.length} | Polymarket ${p.length}`);

  // Indicizza Polymarket per data di chiusura (giorno) → candidati ridotti
  const perGiorno = new Map();
  for (const pm of p) {
    const g = String(pm.endDate || "").slice(0, 10);
    if (!g || g.length < 10) continue;
    if (!perGiorno.has(g)) perGiorno.set(g, []);
    perGiorno.get(g).push(pm);
  }

  const hits = [];
  let candidati = 0, accoppiate = 0;

  for (const km of k) {
    const gk = String(km.closeTime || "").slice(0, 10);
    // cerca nello stesso giorno ± 1
    const giorni = [gk];
    const d = new Date(gk + "T00:00:00Z");
    if (isFinite(d.getTime())) {
      const avanti = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
      const dietro = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
      giorni.push(avanti, dietro);
    }

    let pool = [];
    for (const g of giorni) pool.push(...(perGiorno.get(g) || []));
    candidati += pool.length;

    let best = null, bestInfo = null, bestScore = 0;
    for (const pm of pool) {
      const info = matchValido(km, pm);
      if (!info) continue;
      if (info.score > bestScore) { bestScore = info.score; best = pm; bestInfo = info; }
    }
    if (!best) continue;
    accoppiate++;

    const [pYes, pNo] = await Promise.all([polyAsk(best.yesToken), polyAsk(best.noToken)]);
    if (pYes === null || pNo === null) continue;

    const costA = km.yesAsk + pNo;
    const costB = km.noAsk + pYes;
    const cost = Math.min(costA, costB);
    const leg = costA <= costB ? "K_YES + P_NO" : "K_NO + P_YES";

    if (cost < 1.0) {
      hits.push({
        edge: 1 - cost, leg,
        overlap: Math.round(bestScore * 100),
        comuni: bestInfo.comuni, distGiorni: +bestInfo.dist.toFixed(2),
        tipo: bestInfo.tipo,
        kalshi_id: km.id, kalshi_title: km.title, kalshi_rules: km.rules,
        kalshi_vol: km.vol, kalshi_close: km.closeTime,
        poly_id: best.id, poly_title: best.title, poly_vol: best.vol,
        cost: +cost.toFixed(4),
      });
    }
  }

  console.log(`[scan] candidati per data: ${candidati}`);
  console.log(`[scan] accoppiati (matching severo): ${accoppiate}`);
  hits.sort((a, b) => b.edge - a.edge);
  console.log(`[scan] edge < 1.00: ${hits.length}`);
  if (hits[0]) {
    console.log(`[scan] MIGLIORE: ${(hits[0].edge*100).toFixed(2)}% | ${hits[0].tipo} | ${hits[0].kalshi_title}`);
  }

  const top = hits.slice(0, 100);
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
        `parole_comuni=${h.comuni}`,
        `dist_giorni=${h.distGiorni}`,
        `tipo=${h.tipo}`,
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
    console.log(`[scan] nessuna riga`);
  }
}

(async () => {
  try { await scanOnce(); }
  catch (e) { console.error("errore:", e); process.exit(1); }
})();
