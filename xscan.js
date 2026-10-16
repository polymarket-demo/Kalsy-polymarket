require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const POLL_MS = 2000;
const DURATA_MIN = 70;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Trova il mercato BTC 5 minuti in corso ──────────────────────────────
async function trovaMercato() {
  const r = await fetch(`${GAMMA}/markets?closed=false&active=true&limit=500`);
  if (!r.ok) throw new Error(`gamma HTTP ${r.status}`);
  const j = await r.json();
  const arr = Array.isArray(j) ? j : j.data || [];
  console.log(`[gamma] ${arr.length} mercati attivi`);

  const cand = arr.filter(m => {
    const s = (m.slug || "").toLowerCase();
    const q = (m.question || "").toLowerCase();
    return (s.includes("btc") && (s.includes("5m") || s.includes("5-min"))) ||
           (q.includes("bitcoin") && q.includes("min"));
  });

  if (!cand.length) {
    console.log(`[gamma] nessun BTC 5m trovato. Esempi di slug reali:`);
    for (const m of arr.slice(0, 8)) console.log(`   ${m.slug}`);
    return null;
  }

  console.log(`[gamma] ${cand.length} candidati BTC 5m`);

  cand.sort((a, b) => new Date(a.endDate) - new Date(b.endDate));
  const m = cand[0];

  let tok = [], outs = [];
  try { tok = JSON.parse(m.clobTokenIds || "[]"); } catch {}
  try { outs = JSON.parse(m.outcomes || "[]"); } catch {}
  if (tok.length < 2) {
    console.log(`[gamma] token mancanti su ${m.slug}`);
    return null;
  }

  const iUp = outs.findIndex(o => /up/i.test(o));
  const iDn = outs.findIndex(o => /down/i.test(o));

  console.log(`[gamma] round scelto: ${m.slug} | ${m.question} | chiude ${m.endDate}`);
  console.log(`[gamma] outcomes: ${JSON.stringify(outs)}`);

  return {
    conditionId: m.conditionId,
    question: m.question,
    slug: m.slug,
    endDate: m.endDate,
    upToken: tok[iUp >= 0 ? iUp : 0],
    downToken: tok[iDn >= 0 ? iDn : 1],
  };
}

// ── Leggi il book completo (bid/ask/size) ───────────────────────────────
async function leggiBook(tokenId) {
  try {
    const r = await fetch(`${CLOB}/book?token_id=${tokenId}`);
    if (!r.ok) return null;
    const j = await r.json();
    const bids = (j.bids || []).map(b => ({ p: parseFloat(b.price), s: parseFloat(b.size) }))
      .filter(x => x.p > 0 && x.p < 1);
    const asks = (j.asks || []).map(a => ({ p: parseFloat(a.price), s: parseFloat(a.size) }))
      .filter(x => x.p > 0 && x.p < 1);
    if (!bids.length || !asks.length) return null;
    bids.sort((a, b) => b.p - a.p);
    asks.sort((a, b) => a.p - b.p);

    const sizeFino = (livelli, limite) =>
      livelli.filter(l => l.p <= limite).reduce((t, l) => t + l.s, 0);

    return {
      bid: bids[0].p, bidSize: bids[0].s,
      ask: asks[0].p, askSize: asks[0].s,
      sizeAsk47: sizeFino(asks, 0.47),
      sizeAsk48: sizeFino(asks, 0.48),
      sizeAsk49: sizeFino(asks, 0.49),
      spread: +(asks[0].p - bids[0].p).toFixed(4),
    };
  } catch { return null; }
}

// ── Registra un round ───────────────────────────────────────────────────
async function registraRound(mkt) {
  const inizio = Date.now();
  const fine = new Date(mkt.endDate).getTime();
  console.log(`\n=== ${mkt.question} | chiude ${mkt.endDate} ===`);

  const righe = [];
  let letture = 0;

  while (Date.now() < fine && Date.now() - inizio < 6 * 60 * 1000) {
    const rem = Math.max(0, (fine - Date.now()) / 60000);
    const [bUp, bDn] = await Promise.all([
      leggiBook(mkt.upToken),
      leggiBook(mkt.downToken),
    ]);

    if (bUp && bDn) {
      letture++;
      righe.push({
        rem: +rem.toFixed(2),
        up_ask: bUp.ask, up_ask_size: bUp.askSize,
        up_size47: bUp.sizeAsk47, up_size48: bUp.sizeAsk48,
        up_bid: bUp.bid,
        dn_ask: bDn.ask, dn_ask_size: bDn.askSize,
        dn_size47: bDn.sizeAsk47, dn_size48: bDn.sizeAsk48,
        dn_bid: bDn.bid,
      });

      if (letture % 15 === 0) {
        console.log(
          `rem ${rem.toFixed(1)}' | UP ask ${bUp.ask} (size<=.47: ${bUp.sizeAsk47}) ` +
          `| DN ask ${bDn.ask} (size<=.48: ${bDn.sizeAsk48})`
        );
      }
    }
    await sleep(POLL_MS);
  }

  console.log(`[round] ${letture} letture`);
  return { righe, ticket: mkt };
}

// ── Analisi ─────────────────────────────────────────────────────────────
function analizza(tutti) {
  const flat = tutti.flatMap(r => r.righe);
  if (!flat.length) return null;

  const media = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const mediana = a => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };

  const upAsk = flat.map(r => r.up_ask);
  const dnAsk = flat.map(r => r.dn_ask);
  const sommaAsk = flat.map(r => r.up_ask + r.dn_ask);

  const entrambi4748 = flat.filter(r => r.up_ask <= 0.47 && r.dn_ask <= 0.48).length;
  const entrambi4747 = flat.filter(r => r.up_ask <= 0.47 && r.dn_ask <= 0.47).length;
  const entrambi4848 = flat.filter(r => r.up_ask <= 0.48 && r.dn_ask <= 0.48).length;

  const sizeUp47 = flat.map(r => r.up_size47).filter(s => s > 0);
  const sizeDn48 = flat.map(r => r.dn_size48).filter(s => s > 0);

  return {
    letture: flat.length,
    round: tutti.length,
    upAskMedio: +media(upAsk).toFixed(3),
    dnAskMedio: +media(dnAsk).toFixed(3),
    upAskMediano: +mediana(upAsk).toFixed(3),
    dnAskMediano: +mediana(dnAsk).toFixed(3),
    sommaAskMedia: +media(sommaAsk).toFixed(3),
    sommaAskMediana: +mediana(sommaAsk).toFixed(3),
    pctEntrambi4748: +(entrambi4748 / flat.length * 100).toFixed(1),
    pctEntrambi4747: +(entrambi4747 / flat.length * 100).toFixed(1),
    pctEntrambi4848: +(entrambi4848 / flat.length * 100).toFixed(1),
    sizeMediaUp47: +media(sizeUp47).toFixed(1),
    sizeMediaDn48: +media(sizeDn48).toFixed(1),
  };
}

// ── Main ────────────────────────────────────────────────────────────────
(async () => {
  const fine = Date.now() + DURATA_MIN * 60000;
  const tutti = [];

  while (Date.now() < fine) {
    const mkt = await trovaMercato();
    if (!mkt) {
      console.log("riprovo tra 20s");
      await sleep(20000);
      continue;
    }
    try {
      const r = await registraRound(mkt);
      tutti.push(r);
    } catch (e) {
      console.error("errore round:", e.message);
    }
    await sleep(3000);
  }

  const a = analizza(tutti);
  console.log("\n=== ANALISI ===");
  console.log(JSON.stringify(a, null, 2));

  if (a) {
    const { error } = await supabase.from("signals").insert([{
      category: "btc-book-test",
      market_title: `Misurazione book ${a.round} round`,
      signal_type: "book-misura",
      detail: JSON.stringify(a),
      edge: +(1 - a.sommaAskMedia).toFixed(4),
      live: null,
    }]);
    if (error) console.error("insert:", error.message);
    else console.log("scritto su Supabase");
  }
})();
