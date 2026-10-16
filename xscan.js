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

// ── Trova il round BTC 5m IN CORSO, calcolando lo slug ─────────────────
// Lo slug e' btc-updown-5m-<epoch dell'apertura>. Ora arrotondata a 300s.
async function trovaMercato() {
  const adessoSec = Math.floor(Date.now() / 1000);
  const inizio = Math.floor(adessoSec / 300) * 300;

  // prova il round corrente e i 2 precedenti (nel caso sia appena partito)
  for (const off of [0, -300, -600]) {
    const slug = `btc-updown-5m-${inizio + off}`;
    const url = `${GAMMA}/events?slug=${slug}`;
    try {
      const r = await fetch(url);
      if (!r.ok) { console.log(`[gamma] HTTP ${r.status} per ${slug}`); continue; }
      const j = await r.json();
      const evs = Array.isArray(j) ? j : j.data || [];
      if (!evs.length) { console.log(`[gamma] ${slug} non esiste`); continue; }

      const ev = evs[0];
      const ms = ev.markets || [];
      console.log(`[gamma] trovato ${slug} con ${ms.length} mercati`);
      if (!ms.length) continue;

      const m = ms[0];
      let tok = [], outs = [];
      try { tok = JSON.parse(m.clobTokenIds || "[]"); } catch {}
      try { outs = JSON.parse(m.outcomes || "[]"); } catch {}
      if (tok.length < 2) { console.log(`[gamma] token mancanti`); continue; }

      const iUp = outs.findIndex(o => /up/i.test(o));
      const iDn = outs.findIndex(o => /down/i.test(o));
      const fine = new Date(m.endDate).getTime();
      const manca = (fine - Date.now()) / 60000;

      console.log(`[gamma] ROUND ${m.slug} | chiude tra ${manca.toFixed(1)}' | outcomes ${JSON.stringify(outs)}`);

      return {
        conditionId: m.conditionId, question: m.question, slug: m.slug,
        endDate: m.endDate,
        upToken: tok[iUp >= 0 ? iUp : 0],
        downToken: tok[iDn >= 0 ? iDn : 1],
      };
    } catch (e) {
      console.log(`[gamma] errore su ${slug}: ${e.message}`);
    }
  }
  return null;
}

// ── Leggi il book (bid/ask/size) ────────────────────────────────────────
async function leggiBook(tokenId) {
  try {
    const r = await fetch(`${CLOB}/book?token_id=${tokenId}`);
    if (!r.ok) {
      console.log(`[book] HTTP ${r.status}`);
      return null;
    }
    const j = await r.json();
    const bids = (j.bids || []).map(b => ({ p: parseFloat(b.price), s: parseFloat(b.size) }))
      .filter(x => x.p > 0 && x.p < 1);
    const asks = (j.asks || []).map(a => ({ p: parseFloat(a.price), s: parseFloat(a.size) }))
      .filter(x => x.p > 0 && x.p < 1);
    if (!bids.length || !asks.length) {
      console.log(`[book] vuoto (bids ${bids.length}, asks ${asks.length})`);
      return null;
    }
    bids.sort((a, b) => b.p - a.p);
    asks.sort((a, b) => a.p - b.p);
    const sizeFino = (liv, lim) => liv.filter(l => l.p <= lim).reduce((t, l) => t + l.s, 0);
    return {
      bid: bids[0].p, ask: asks[0].p,
      sizeAsk47: sizeFino(asks, 0.47),
      sizeAsk48: sizeFino(asks, 0.48),
    };
  } catch (e) {
    console.log(`[book] errore: ${e.message}`);
    return null;
  }
}

// ── Registra un round ───────────────────────────────────────────────────
async function registraRound(mkt) {
  const inizio = Date.now();
  const fine = new Date(mkt.endDate).getTime();
  console.log(`\n=== ${mkt.slug} | ${mkt.question} ===`);

  const righe = [];
  let letture = 0;

  while (Date.now() < fine && Date.now() - inizio < 6 * 60 * 1000) {
    const rem = Math.max(0, (fine - Date.now()) / 60000);
    const [bUp, bDn] = await Promise.all([leggiBook(mkt.upToken), leggiBook(mkt.downToken)]);
    if (bUp && bDn) {
      letture++;
      righe.push({
        rem: +rem.toFixed(2),
        up_ask: bUp.ask, up_size47: bUp.sizeAsk47, up_size48: bUp.sizeAsk48, up_bid: bUp.bid,
        dn_ask: bDn.ask, dn_size47: bDn.sizeAsk47, dn_size48: bDn.sizeAsk48, dn_bid: bDn.bid,
      });
      if (letture % 15 === 1) {
        console.log(`rem ${rem.toFixed(1)}' | UP ask ${bUp.ask} (<=.47: ${bUp.sizeAsk47}) | DN ask ${bDn.ask} (<=.48: ${bDn.sizeAsk48})`);
      }
    }
    await sleep(POLL_MS);
  }
  console.log(`[round] ${letture} letture`);
  return { righe };
}

// ── Analisi ─────────────────────────────────────────────────────────────
function analizza(tutti) {
  const flat = tutti.flatMap(r => r.righe);
  if (!flat.length) return null;
  const media = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const mediana = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const up = flat.map(r => r.up_ask), dn = flat.map(r => r.dn_ask);
  const somma = flat.map(r => r.up_ask + r.dn_ask);
  const c4748 = flat.filter(r => r.up_ask <= 0.47 && r.dn_ask <= 0.48).length;
  const c4747 = flat.filter(r => r.up_ask <= 0.47 && r.dn_ask <= 0.47).length;
  const c4848 = flat.filter(r => r.up_ask <= 0.48 && r.dn_ask <= 0.48).length;
  const s47 = flat.map(r => r.up_size47).filter(s => s > 0);
  const s48 = flat.map(r => r.dn_size48).filter(s => s > 0);
  return {
    letture: flat.length,
    upAskMedio: +media(up).toFixed(3), dnAskMedio: +media(dn).toFixed(3),
    upAskMediano: +mediana(up).toFixed(3), dnAskMediano: +mediana(dn).toFixed(3),
    sommaAskMedia: +media(somma).toFixed(3), sommaAskMediana: +mediana(somma).toFixed(3),
    pctEntrambi4748: +(c4748 / flat.length * 100).toFixed(1),
    pctEntrambi4747: +(c4747 / flat.length * 100).toFixed(1),
    pctEntrambi4848: +(c4848 / flat.length * 100).toFixed(1),
    sizeMediaUp47: +media(s47).toFixed(1),
    sizeMediaDn48: +media(s48).toFixed(1),
  };
}

// ── Main ────────────────────────────────────────────────────────────────
(async () => {
  const fine = Date.now() + DURATA_MIN * 60000;
  const tutti = [];
  let ultimoSlug = null;

  while (Date.now() < fine) {
    const mkt = await trovaMercato();
    if (!mkt) { console.log("riprovo tra 15s"); await sleep(15000); continue; }

    if (mkt.slug === ultimoSlug) {
      console.log(`[main] ${mkt.slug} gia' registrato, aspetto il prossimo`);
      await sleep(15000);
      continue;
    }
    ultimoSlug = mkt.slug;

    try { tutti.push(await registraRound(mkt)); }
    catch (e) { console.error("errore round:", e.message); }
    await sleep(3000);
  }

  const a = analizza(tutti);
  console.log("\n=== ANALISI ===");
  console.log(JSON.stringify(a, null, 2));

  if (a) {
    const { error } = await supabase.from("signals").insert([{
      category: "btc-book-test",
      market_title: `Misurazione book ${tutti.length} round`,
      signal_type: "book-misura",
      detail: JSON.stringify(a),
      edge: +(1 - a.sommaAskMedia).toFixed(4),
      live: null,
    }]);
    if (error) console.error("insert:", error.message);
    else console.log("scritto su Supabase");
  }
})();
