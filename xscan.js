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

// ── Trova il round APPENA iniziato (salta quelli gia' avviati) ──────────
async function trovaMercato() {
  const now = Math.floor(Date.now() / 1000);
  const base = Math.floor(now / 300) * 300;

  for (const off of [0, -300]) {
    const slug = `btc-updown-5m-${base + off}`;
    let r;
    try { r = await fetch(`${GAMMA}/events?slug=${slug}`); } catch { continue; }
    if (!r.ok) continue;
    let j;
    try { j = await r.json(); } catch { continue; }
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
    const manca = (fine - Date.now()) / 60000;

    // accetta solo il round APPENA iniziato (tra 4.6 e 5.4 minuti rimanenti)
    if (manca < 4.6 || manca > 5.4) continue;

    console.log(`[gamma] ROUND ${m.slug} | chiude tra ${manca.toFixed(1)}'`);
    return {
      slug: m.slug, question: m.question, fine, conditionId: m.conditionId,
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

// ── Esito ufficiale letto da Gamma ──────────────────────────────────────
async function esitoDaGamma(conditionId, slug) {
  // 1) prova con l'evento
  try {
    const r = await fetch(`${GAMMA}/events?slug=${slug}`);
    if (r.ok) {
      const j = await r.json();
      const evs = Array.isArray(j) ? j : j.data || [];
      const m = ((evs[0] || {}).markets || [])[0];
      if (m) {
        // outcomePrices e' tipo "[\"1\", \"0\"]" → il primo e' UP, il secondo DOWN
        let prices = [];
        try { prices = JSON.parse(m.outcomePrices || "[]"); } catch {}
        let outs = [];
        try { outs = JSON.parse(m.outcomes || "[]"); } catch {}
        if (prices.length === 2 && outs.length === 2) {
          const iUp = outs.findIndex(o => /up/i.test(o));
          const iDn = outs.findIndex(o => /down/i.test(o));
          const pUp = parseFloat(prices[iUp >= 0 ? iUp : 0]);
          const pDn = parseFloat(prices[iDn >= 0 ? iDn : 1]);
          if (isFinite(pUp) && isFinite(pDn) && (pUp > 0.95 || pDn > 0.95)) {
            return pUp > pDn ? "UP" : "DOWN";
          }
        }
      }
    }
  } catch {}

  // 2) fallback: chiedi il mercato per conditionId
  if (conditionId) {
    try {
      const r = await fetch(`${GAMMA}/markets?condition_ids=${conditionId}`);
      if (r.ok) {
        const j = await r.json();
        const arr = Array.isArray(j) ? j : j.data || [];
        const m = arr[0];
        if (m) {
          let prices = [];
          try { prices = JSON.parse(m.outcomePrices || "[]"); } catch {}
          let outs = [];
          try { outs = JSON.parse(m.outcomes || "[]"); } catch {}
          if (prices.length === 2 && outs.length === 2) {
            const iUp = outs.findIndex(o => /up/i.test(o));
            const iDn = outs.findIndex(o => /down/i.test(o));
            const pUp = parseFloat(prices[iUp >= 0 ? iUp : 0]);
            const pDn = parseFloat(prices[iDn >= 0 ? iDn : 1]);
            if (isFinite(pUp) && isFinite(pDn) && (pUp > 0.95 || pDn > 0.95)) {
              return pUp > pDn ? "UP" : "DOWN";
            }
          }
        }
      }
    } catch {}
  }
  return "?";
}

// ── Registra un round ───────────────────────────────────────────────────
async function registraRound(mkt) {
  console.log(`\n=== ${mkt.slug} | ${mkt.question} ===`);

  let lettureOk = 0;
  let lettureVuote = 0;      // book risposto ma vuoto
  let lettureErrore = 0;     // fetch fallita
  let upTocco = null;
  let dnTocco = null;
  let minUp = 99, minDn = 99;

  while (Date.now() < mkt.fine) {
    const rem = Math.max(0, (mkt.fine - Date.now()) / 60000);
    let bUp = null, bDn = null;
    try {
      [bUp, bDn] = await Promise.all([book(mkt.upToken), book(mkt.downToken)]);
    } catch { lettureErrore++; await sleep(POLL_MS); continue; }

    if (bUp === null || bDn === null) { lettureVuote++; }
    else if (bUp.ask !== null && bDn.ask !== null) {
      lettureOk++;
      if (bUp.ask < minUp) minUp = bUp.ask;
      if (bDn.ask < minDn) minDn = bDn.ask;

      if (!upTocco && bUp.ask <= SOGLIA) {
        upTocco = { px: bUp.ask, rem, size: bUp.size47 };
        console.log(`  UP tocca ${SOGLIA} a ${rem.toFixed(2)}' (ask ${bUp.ask}, size ${bUp.size47.toFixed(0)})`);
      }
      if (!dnTocco && bDn.ask <= SOGLIA) {
        dnTocco = { px: bDn.ask, rem, size: bDn.size47 };
        console.log(`  DOWN tocca ${SOGLIA} a ${rem.toFixed(2)}' (ask ${bDn.ask}, size ${bDn.size47.toFixed(0)})`);
      }

      if (lettureOk % 40 === 1) {
        console.log(`  rem ${rem.toFixed(1)}' | UP ${bUp.ask} | DN ${bDn.ask} | ok ${lettureOk} vuote ${lettureVuote}`);
      }
    }
    await sleep(POLL_MS);
  }

  // ── esito ufficiale ──
  const vincitore = await esitoDaGamma(mkt.conditionId, mkt.slug);

  // ── chi ha toccato per primo ──
  let primo = null, salitoDiretto = null;
  if (upTocco && dnTocco) primo = upTocco.rem > dnTocco.rem ? "UP" : "DOWN";
  else if (upTocco) { primo = "UP"; salitoDiretto = "DOWN"; }
  else if (dnTocco) { primo = "DOWN"; salitoDiretto = "UP"; }

  const esito = upTocco && dnTocco ? "COPPIA"
              : (upTocco || dnTocco ? "UN_LATO" : "NIENTE_LETTURE");
  const costo = upTocco && dnTocco ? upTocco.px + dnTocco.px : null;
  const mioLato = primo;
  const ioVinto = (mioLato && vincitore !== "?") ? mioLato === vincitore : null;

  console.log(`\n>>> ROUND ${mkt.slug}`);
  console.log(`    letture ok: ${lettureOk} | vuote: ${lettureVuote} | errori: ${lettureErrore}`);
  console.log(`    UP   tocca ${SOGLIA}: ${upTocco ? upTocco.px + " @ " + upTocco.rem.toFixed(2) + "min" : "NO"} (minimo ${minUp === 99 ? "-" : minUp})`);
  console.log(`    DOWN tocca ${SOGLIA}: ${dnTocco ? dnTocco.px + " @ " + dnTocco.rem.toFixed(2) + "min" : "NO"} (minimo ${minDn === 99 ? "-" : minDn})`);
  console.log(`    PRIMO: ${primo || "nessuno"}${salitoDiretto ? ` | ${salitoDiretto} è SALITO senza scendere` : ""}`);
  console.log(`    ESITO: ${esito}${costo ? " | costo " + costo.toFixed(2) + " | PnL " + (1 - costo).toFixed(2) : ""}`);
  console.log(`    VINCE: ${vincitore}`);
  if (mioLato && ioVinto !== null) console.log(`    IL MIO LATO (${mioLato}) → ${ioVinto ? "VINTO" : "PERSO"}`);
  console.log(`<<<\n`);

  return {
    slug: mkt.slug, question: mkt.question, esito, costo,
    upTocco, dnTocco, primo, salitoDiretto, vincitore, mioLato, ioVinto,
    lettureOk, lettureVuote, lettureErrore, minUp: minUp === 99 ? null : minUp, minDn: minDn === 99 ? null : minDn,
  };
}

// ── Main ────────────────────────────────────────────────────────────────
(async () => {
  const fine = Date.now() + DURATA_MIN * 60000;
  const fatti = new Set();
  const risultati = [];

  while (Date.now() < fine) {
    const mkt = await trovaMercato();
    if (!mkt) {
      const now = Math.floor(Date.now() / 1000);
      const prox = (Math.floor(now / 300) + 1) * 300 + 3;
      const attesa = Math.max(3000, (prox - now) * 1000);
      console.log(`[main] nessun round appena iniziato, attendo ${(attesa / 1000).toFixed(0)}s`);
      await sleep(attesa);
      continue;
    }
    if (fatti.has(mkt.slug)) { await sleep(15000); continue; }

    try {
      const r = await registraRound(mkt);
      fatti.add(mkt.slug);
      risultati.push(r);

      await supabase.from("signals").insert([{
        category: "btc-maker-test",
        market_title: r.slug,
        condition_id: r.conditionId || null,
        signal_type: r.esito,
        detail: JSON.stringify({
          up: r.upTocco, dn: r.dnTocco, costo: r.costo,
          primo: r.primo, salitoDiretto: r.salitoDiretto,
          vince: r.vincitore, mioLato: r.mioLato, ioVinto: r.ioVinto,
          lettureOk: r.lettureOk, lettureVuote: r.lettureVuote, lettureErrore: r.lettureErrore,
          minUp: r.minUp, minDn: r.minDn,
        }),
        edge: r.costo ? +(1 - r.costo).toFixed(4) : null,
        live: r.esito === "COPPIA",
      }]);
    } catch (e) {
      console.error("errore round:", e.message);
    }

    const now = Math.floor(Date.now() / 1000);
    const prox = (Math.floor(now / 300) + 1) * 300 + 3;
    await sleep(Math.max(2000, (prox - now) * 1000));
  }

  // ── RIEPILOGO FINALE ──
  const coppie = risultati.filter(r => r.esito === "COPPIA");
  const unLato = risultati.filter(r => r.esito === "UN_LATO");
  const vinti = unLato.filter(r => r.ioVinto === true).length;
  const pnl = coppie.reduce((t, r) => t + (1 - r.costo), 0);
  const costoMedio = coppie.length ? coppie.reduce((t, r) => t + r.costo, 0) / coppie.length : 0;

  console.log(`\n════ RIEPILOGO FINALE ════`);
  console.log(`round registrati: ${risultati.length}`);
  console.log(`COPPIA:  ${coppie.length} | costo medio ${costoMedio.toFixed(3)} | PnL medio ${coppie.length ? (pnl / coppie.length).toFixed(3) : "-"} | PnL totale ${pnl.toFixed(2)}`);
  console.log(`UN_LATO: ${unLato.length} | di cui il lato comprato ha vinto: ${vinti}`);
  console.log(`NIENTE_LETTURE: ${risultati.filter(r => r.esito === "NIENTE_LETTURE").length}`);
  console.log(`TOTALE round: ${risultati.length}`);
})();
