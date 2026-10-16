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
const SOGLIA = 0.47;
const DURATA_MIN = 70;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Trova il round in corso ─────────────────────────────────────────────
async function trovaMercato() {
  const now = Math.floor(Date.now() / 1000);
  const base = Math.floor(now / 300) * 300;

  for (const off of [0, -300]) {
    const slug = `btc-updown-5m-${base + off}`;
    const r = await fetch(`${GAMMA}/events?slug=${slug}`);
    if (!r.ok) continue;
    const j = await r.json();
    const evs = Array.isArray(j) ? j : j.data || [];
    if (!evs.length) continue;

    const m = (evs[0].markets || [])[0];
    if (!m) continue;

    let tok = [], outs = [];
    try { tok = JSON.parse(m.clobTokenIds || "[]"); } catch {}
    try { outs = JSON.parse(m.outcomes || "[]"); } catch {}
    if (tok.length < 2) continue;

    const iUp = outs.findIndex(o => /up/i.test(o));
    const iDn = outs.findIndex(o => /down/i.test(o));
    const fine = new Date(m.endDate).getTime();
    if (fine < Date.now()) continue;

    console.log(`[gamma] ROUND ${m.slug} | chiude tra ${((fine - Date.now()) / 60000).toFixed(1)}'`);
    return {
      slug: m.slug, question: m.question, fine,
      upToken: tok[iUp >= 0 ? iUp : 0],
      downToken: tok[iDn >= 0 ? iDn : 1],
    };
  }
  return null;
}

// ── Book ────────────────────────────────────────────────────────────────
async function book(tokenId) {
  try {
    const r = await fetch(`${CLOB}/book?token_id=${tokenId}`);
    if (!r.ok) return null;
    const j = await r.json();
    const bids = (j.bids || []).map(b => ({ p: parseFloat(b.price), s: parseFloat(b.size) }))
      .filter(x => x.p > 0 && x.p < 1);
    const asks = (j.asks || []).map(a => ({ p: parseFloat(a.price), s: parseFloat(a.size) }))
      .filter(x => x.p > 0 && x.p < 1);
    if (!bids.length && !asks.length) return null;
    bids.sort((a, b) => b.p - a.p);
    asks.sort((a, b) => a.p - b.p);
    const sizeFino = (liv, lim) => liv.filter(l => l.p <= lim).reduce((t, l) => t + l.s, 0);
    return {
      bid: bids.length ? bids[0].p : null,
      ask: asks.length ? asks[0].p : null,
      size47: sizeFino(asks, 0.47),
    };
  } catch { return null; }
}

// ── Registra un round ───────────────────────────────────────────────────
async function registraRound(mkt) {
  console.log(`\n=== ${mkt.slug} | ${mkt.question} ===`);

  let letture = 0;
  let upTocco = null;   // { px, rem, size }
  let dnTocco = null;

  while (Date.now() < mkt.fine) {
    const rem = Math.max(0, (mkt.fine - Date.now()) / 60000);
    const [bUp, bDn] = await Promise.all([book(mkt.upToken), book(mkt.downToken)]);

    if (bUp && bDn && bUp.ask !== null && bDn.ask !== null) {
      letture++;

      if (!upTocco && bUp.ask <= SOGLIA) {
        upTocco = { px: bUp.ask, rem, size: bUp.size47 };
        console.log(`  UP tocca ${SOGLIA} a ${rem.toFixed(2)}' (ask ${bUp.ask}, size ${bUp.size47.toFixed(0)})`);
      }
      if (!dnTocco && bDn.ask <= SOGLIA) {
        dnTocco = { px: bDn.ask, rem, size: bDn.size47 };
        console.log(`  DOWN tocca ${SOGLIA} a ${rem.toFixed(2)}' (ask ${bDn.ask}, size ${bDn.size47.toFixed(0)})`);
      }

      if (letture % 40 === 1) {
        console.log(`  rem ${rem.toFixed(1)}' | UP ${bUp.ask} | DN ${bDn.ask}`);
      }
    }
    await sleep(POLL_MS);
  }

  // ── ESITO: chi ha vinto (letto dal book a round chiuso) ──
  let vincitore = "?";
  let fUp = null, fDn = null;
  try {
    const [a, b] = await Promise.all([book(mkt.upToken), book(mkt.downToken)]);
    fUp = a; fDn = b;
    if (a && b && a.bid !== null && b.bid !== null) {
      vincitore = a.bid > b.bid ? "UP" : "DOWN";
    }
  } catch {}

  // ── Chi ha toccato per primo, e l'altro è salito diretto? ──
  let primo = null, secondo = null, salitoDiretto = null;

  if (upTocco && dnTocco) {
    // tocca prima chi ha rem maggiore (piu' minuti residui = piu' presto)
    primo = upTocco.rem > dnTocco.rem ? "UP" : "DOWN";
    secondo = primo === "UP" ? "DOWN" : "UP";
  } else if (upTocco) {
    primo = "UP"; salitoDiretto = "DOWN";
  } else if (dnTocco) {
    primo = "DOWN"; salitoDiretto = "UP";
  }

  const esito = upTocco && dnTocco ? "COPPIA"
              : (upTocco || dnTocco ? "UN_LATO" : "NESSUNO");
  const costo = upTocco && dnTocco ? upTocco.px + dnTocco.px : null;

  // il mio lato è il PRIMO che scende (compro quello)
  const mioLato = primo;
  const ioVinto = (mioLato && vincitore !== "?") ? mioLato === vincitore : null;

  console.log(`\n>>> ROUND ${mkt.slug}`);
  console.log(`    letture: ${letture}`);
  console.log(`    UP   tocca ${SOGLIA}: ${upTocco ? upTocco.px + " @ " + upTocco.rem.toFixed(2) + "min" : "NO"}`);
  console.log(`    DOWN tocca ${SOGLIA}: ${dnTocco ? dnTocco.px + " @ " + dnTocco.rem.toFixed(2) + "min" : "NO"}`);
  console.log(`    PRIMO: ${primo || "nessuno"}${salitoDiretto ? ` | ${salitoDiretto} è SALITO senza scendere` : ""}`);
  console.log(`    ESITO: ${esito}${costo ? " | costo " + costo.toFixed(2) + " | PnL " + (1 - costo).toFixed(2) : ""}`);
  console.log(`    VINCE: ${vincitore} (UP bid ${fUp ? fUp.bid : "?"} / DN bid ${fDn ? fDn.bid : "?"})`);
  if (mioLato && ioVinto !== null) {
    console.log(`    IL MIO LATO (${mioLato}) → ${ioVinto ? "VINTO ✓" : "PERSO ✗"}`);
  }
  console.log(`<<<\n`);

  return {
    slug: mkt.slug, letture, esito, upTocco, dnTocco, costo,
    vincitore, primo, salitoDiretto, mioLato, ioVinto,
  };
}

// ── Main ────────────────────────────────────────────────────────────────
(async () => {
  const fine = Date.now() + DURATA_MIN * 60000;
  const fatti = new Set();
  const risultati = [];

  while (Date.now() < fine) {
    const mkt = await trovaMercato();
    if (!mkt) { console.log("riprovo tra 15s"); await sleep(15000); continue; }
    if (fatti.has(mkt.slug)) { await sleep(15000); continue; }

    try {
      const r = await registraRound(mkt);
      fatti.add(mkt.slug);
      risultati.push(r);

      await supabase.from("signals").insert([{
        category: "btc-maker-test",
        market_title: r.slug,
        signal_type: r.esito,
        detail: JSON.stringify({
          up: r.upTocco, dn: r.dnTocco, costo: r.costo,
          primo: r.primo, salitoDiretto: r.salitoDiretto,
          vince: r.vincitore, mioLato: r.mioLato, ioVinto: r.ioVinto,
        }),
        edge: r.costo ? +(1 - r.costo).toFixed(4) : null,
        live: r.esito === "COPPIA",
      }]);
    } catch (e) {
      console.error("errore:", e.message);
    }

    const now = Math.floor(Date.now() / 1000);
    const prox = (Math.floor(now / 300) + 1) * 300;
    await sleep(Math.max(1000, (prox - now) * 1000 + 2000));
  }

  // ── RIEPILOGO FINALE ──
  const coppie = risultati.filter(r => r.esito === "COPPIA");
  const unLato = risultati.filter(r => r.esito === "UN_LATO");
  const unLatoVinti = unLato.filter(r => r.ioVinto === true).length;
  const pnlCoppie = coppie.reduce((t, r) => t + (1 - r.costo), 0);

  console.log(`\n════ RIEPILOGO FINALE ════`);
  console.log(`round: ${risultati.length}`);
  console.log(`COPPIA:  ${coppie.length}  → PnL medio ${coppie.length ? (pnlCoppie / coppie.length).toFixed(3) : "n/d"} | totale ${pnlCoppie.toFixed(2)}`);
  console.log(`UN_LATO: ${unLato.length}  → di cui il PRIMO lato ha vinto: ${unLatoVinti}`);
  console.log(`NESSUNO: ${risultati.filter(r => r.esito === "NESSUNO").length}`);
})();
