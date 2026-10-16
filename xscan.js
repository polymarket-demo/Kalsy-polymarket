require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const POLL_MS = 1500;
const SOGLIA = 0.47;
const DURATA_MIN = 70;
const FEE_CRYPTO = 0.07;      // fee taker: fee = p*(1-p)*0.07 per share

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Trova il round APPENA iniziato (accetta solo da 4.9' in su) ─────────
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
    const condId = m.conditionId;
    const fine = new Date(m.endDate).getTime();
    const manca = (fine - Date.now()) / 60000;

    // ◀ SOLO round appena partiti: da 4.90' a 5.60' rimanenti
    if (manca < 4.90 || manca > 5.60) continue;

    console.log(`[gamma] ROUND ${m.slug} | chiude tra ${manca.toFixed(2)}'`);
    return {
      slug: m.slug, question: m.question, fine, conditionId: condId,
      upToken: tok[iUp >= 0 ? iUp : 0],
      downToken: tok[iDn >= 0 ? iDn : 1],
    };
  }
  return null;
}

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

async function feeRewards(conditionId) {
  if (!conditionId) return null;
  try {
    const r = await fetch(`${CLOB}/clob-markets/${conditionId}`);
    if (!r.ok) return null;
    const j = await r.json();
    return {
      makerFee: j.mbf ?? null, takerFee: j.tbf ?? null, rewards: j.r ?? null,
      feeRate: (j.fd && j.fd.r != null) ? j.fd.r : null,
      tickSize: j.mts ?? null, minOrderSize: j.mos ?? null,
      takerDelay: j.itode ?? null,
    };
  } catch { return null; }
}

async function esitoDaGamma(conditionId, slug) {
  try {
    const r = await fetch(`${GAMMA}/events?slug=${slug}`);
    if (r.ok) {
      const j = await r.json();
      const evs = Array.isArray(j) ? j : j.data || [];
      const m = ((evs[0] || {}).markets || [])[0];
      if (m) {
        let prices = [], outs = [];
        try { prices = JSON.parse(m.outcomePrices || "[]"); } catch {}
        try { outs = JSON.parse(m.outcomes || "[]"); } catch {}
        if (prices.length === 2 && outs.length === 2) {
          const iUp = outs.findIndex(o => /up/i.test(o));
          const iDn = outs.findIndex(o => /down/i.test(o));
          const pUp = parseFloat(prices[iUp >= 0 ? iUp : 0]);
          const pDn = parseFloat(prices[iDn >= 0 ? iDn : 1]);
          if (isFinite(pUp) && isFinite(pDn) && (pUp > 0.95 || pDn > 0.95)) return pUp > pDn ? "UP" : "DOWN";
        }
      }
    }
  } catch {}
  if (conditionId) {
    try {
      const r = await fetch(`${GAMMA}/markets?condition_ids=${conditionId}`);
      if (r.ok) {
        const j = await r.json();
        const arr = Array.isArray(j) ? j : j.data || [];
        const m = arr[0];
        if (m) {
          let prices = [], outs = [];
          try { prices = JSON.parse(m.outcomePrices || "[]"); } catch {}
          try { outs = JSON.parse(m.outcomes || "[]"); } catch {}
          if (prices.length === 2 && outs.length === 2) {
            const iUp = outs.findIndex(o => /up/i.test(o));
            const iDn = outs.findIndex(o => /down/i.test(o));
            const pUp = parseFloat(prices[iUp >= 0 ? iUp : 0]);
            const pDn = parseFloat(prices[iDn >= 0 ? iDn : 1]);
            if (isFinite(pUp) && isFinite(pDn) && (pUp > 0.95 || pDn > 0.95)) return pUp > pDn ? "UP" : "DOWN";
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

  let lettureOk = 0, lettureVuote = 0, lettureErrore = 0;
  let upTocco = null, dnTocco = null;
  let minUp = 99, minDn = 99;
  let mio35 = null, mio30 = null;
  let apertura = null;

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

      if (!apertura) {
        apertura = { upAsk: bUp.ask, dnAsk: bDn.ask, rem };
        const upMaker = bUp.ask > SOGLIA;
        const dnMaker = bDn.ask > SOGLIA;
        console.log(`  APERTURA rem ${rem.toFixed(2)}' | UP ${bUp.ask} = ${upMaker ? "MAKER" : "TAKER"} | DN ${bDn.ask} = ${dnMaker ? "MAKER" : "TAKER"}`);
      }

      if (!upTocco && bUp.ask <= SOGLIA) {
        upTocco = { px: bUp.ask, rem, size: bUp.size47 };
        console.log(`  UP tocca ${SOGLIA} a ${rem.toFixed(2)}' (ask ${bUp.ask}, size ${bUp.size47.toFixed(0)})`);
      }
      if (!dnTocco && bDn.ask <= SOGLIA) {
        dnTocco = { px: bDn.ask, rem, size: bDn.size47 };
        console.log(`  DOWN tocca ${SOGLIA} a ${rem.toFixed(2)}' (ask ${bDn.ask}, size ${bDn.size47.toFixed(0)})`);
      }

      if (!(upTocco && dnTocco)) {
        const mioPx = upTocco ? bUp.ask : (dnTocco ? bDn.ask : null);
        if (mioPx !== null) {
          if (mio35 === null && mioPx <= 0.35) mio35 = rem;
          if (mio30 === null && mioPx <= 0.30) mio30 = rem;
        }
      }

      if (lettureOk % 40 === 1) {
        console.log(`  rem ${rem.toFixed(1)}' | UP ${bUp.ask} | DN ${bDn.ask} | ok ${lettureOk} vuote ${lettureVuote}`);
      }
    }
    await sleep(POLL_MS);
  }

  const vincitore = await esitoDaGamma(mkt.conditionId, mkt.slug);
  const fr = await feeRewards(mkt.conditionId);

  let primo = null, salitoDiretto = null;
  if (upTocco && dnTocco) primo = upTocco.rem > dnTocco.rem ? "UP" : "DOWN";
  else if (upTocco) { primo = "UP"; salitoDiretto = "DOWN"; }
  else if (dnTocco) { primo = "DOWN"; salitoDiretto = "UP"; }

  const esito = upTocco && dnTocco ? "COPPIA" : (upTocco || dnTocco ? "UN_LATO" : "NIENTE_LETTURE");
  const costo = upTocco && dnTocco ? upTocco.px + dnTocco.px : null;
  const mioLato = primo;
  const ioVinto = (mioLato && vincitore !== "?") ? mioLato === vincitore : null;

  // ── MAKER/TAKER + FEE + PnL NETTO ──
  let upMaker = null, dnMaker = null, fee = 0;
  let pnlLordo = null, pnlNetto = null;

  if (apertura) {
    upMaker = apertura.upAsk > SOGLIA;
    dnMaker = apertura.dnAsk > SOGLIA;

    // fee = p*(1-p)*0.07 SOLO sul lato che finisce taker (ask <= 0.47 all'apertura)
    if (upTocco && !upMaker) fee += upTocco.px * (1 - upTocco.px) * FEE_CRYPTO;
    if (dnTocco && !dnMaker) fee += dnTocco.px * (1 - dnTocco.px) * FEE_CRYPTO;
    fee = +fee.toFixed(5);

    if (costo !== null) {
      pnlLordo = +(1 - costo).toFixed(4);
      pnlNetto = +(1 - costo - fee).toFixed(4);
    }
  }

  console.log(`\n>>> ROUND ${mkt.slug}`);
  console.log(`    letture ok: ${lettureOk} | vuote: ${lettureVuote} | errori: ${lettureErrore}`);
  console.log(`    UP   tocca ${SOGLIA}: ${upTocco ? upTocco.px + " @ " + upTocco.rem.toFixed(2) + "min" : "NO"} (minimo ${minUp === 99 ? "-" : minUp})`);
  console.log(`    DOWN tocca ${SOGLIA}: ${dnTocco ? dnTocco.px + " @ " + dnTocco.rem.toFixed(2) + "min" : "NO"} (minimo ${minDn === 99 ? "-" : minDn})`);
  console.log(`    PRIMO: ${primo || "nessuno"}${salitoDiretto ? ` | ${salitoDiretto} è SALITO senza scendere` : ""}`);
  console.log(`    ESITO: ${esito}${costo ? " | costo " + costo.toFixed(2) : ""}`);
  console.log(`    VINCE: ${vincitore}`);
  if (esito === "UN_LATO") {
    console.log(`    STOP: sotto 0.35 a ${mio35 === null ? "MAI" : mio35.toFixed(2) + "'"} | sotto 0.30 a ${mio30 === null ? "MAI" : mio30.toFixed(2) + "'"}`);
  }
  if (mioLato && ioVinto !== null) console.log(`    IL MIO LATO (${mioLato}) → ${ioVinto ? "VINTO" : "PERSO"}`);
  if (apertura) {
    console.log(`    MAKER? UP ${upMaker ? "SI" : "NO"} | DN ${dnMaker ? "SI" : "NO"}`);
    if (pnlLordo !== null) {
      console.log(`    PnL: lordo ${pnlLordo} | fee ${fee} | NETTO ${pnlNetto}`);
    }
  }
  if (fr) {
    console.log(`    FEE/REWARDS: maker ${fr.makerFee} | taker ${fr.takerFee} | feeRate ${fr.feeRate} | pool ${fr.rewards ? JSON.stringify(fr.rewards) : "nessuna"} | tick ${fr.tickSize}`);
  }
  console.log(`<<<\n`);

  return {
    slug: mkt.slug, question: mkt.question, esito, costo, pnlLordo, pnlNetto, fee,
    upTocco, dnTocco, primo, salitoDiretto, vincitore, mioLato, ioVinto,
    lettureOk, lettureVuote, lettureErrore,
    minUp: minUp === 99 ? null : minUp, minDn: minDn === 99 ? null : minDn,
    mio35, mio30, apertura, upMaker, dnMaker,
  };
}

// ── Main: aggancia OGNI ciclo al secondo zero ───────────────────────────
(async () => {
  const fine = Date.now() + DURATA_MIN * 60000;
  const fatti = new Set();
  const risultati = [];

  while (Date.now() < fine) {
    const mkt = await trovaMercato();

    if (!mkt) {
      // ◀ POLLING OGNI SECONDO: il round appare su Gamma 1-3s dopo il cambio
      await sleep(1000);
      continue;
    }
    if (fatti.has(mkt.slug)) { await sleep(1000); continue; }

    try {
      const r = await registraRound(mkt);
      fatti.add(mkt.slug);
      risultati.push(r);

      await supabase.from("signals").insert([{
        category: "btc-maker-test",
        market_title: r.slug,
        condition_id: mkt.conditionId || null,
        signal_type: r.esito,
        detail: JSON.stringify({
          up: r.upTocco, dn: r.dnTocco, costo: r.costo,
          pnlLordo: r.pnlLordo, pnlNetto: r.pnlNetto, fee: r.fee,
          primo: r.primo, vince: r.vincitore, mioLato: r.mioLato, ioVinto: r.ioVinto,
          apertura: r.apertura, upMaker: r.upMaker, dnMaker: r.dnMaker,
          lettureOk: r.lettureOk, lettureVuote: r.lettureVuote,
          stop35: r.mio35, stop30: r.mio30,
        }),
        edge: r.pnlNetto,
        live: r.esito === "COPPIA",
      }]);
    } catch (e) {
      console.error("errore round:", e.message);
    }

    // ◀ ALLINEATI ALLA CHIUSURA: sveglia 300ms dopo la fine del round
    const attesa = mkt.fine - Date.now() + 300;
    if (attesa > 0) await sleep(attesa);
  }

  // ── RIEPILOGO CON PnL NETTO ──
  const coppie = risultati.filter(r => r.esito === "COPPIA");
  const unLato = risultati.filter(r => r.esito === "UN_LATO");
  const vinti = unLato.filter(r => r.ioVinto === true).length;

  const lordoTot = coppie.reduce((t, r) => t + (r.pnlLordo || 0), 0);
  const feeTot = coppie.reduce((t, r) => t + (r.fee || 0), 0);
  const nettoTot = lordoTot - feeTot;
  const costoMedio = coppie.length ? coppie.reduce((t, r) => t + r.costo, 0) / coppie.length : 0;

  const conApertura = risultati.filter(r => r.apertura);
  const entrambiMaker = conApertura.filter(r => r.upMaker && r.dnMaker).length;
  const almenoUnTaker = conApertura.filter(r => !r.upMaker || !r.dnMaker).length;

  console.log(`\n════ RIEPILOGO FINALE ════`);
  console.log(`round: ${risultati.length} | COPPIA ${coppie.length} | UN_LATO ${unLato.length} (vinti ${vinti})`);
  console.log(`costo medio coppia: ${costoMedio.toFixed(3)}`);
  console.log(`PnL LORDO: ${lordoTot.toFixed(3)} | FEE: ${feeTot.toFixed(3)} | NETTO: ${nettoTot.toFixed(3)}`);
  console.log(`per round (netto): ${(nettoTot / risultati.length).toFixed(4)}`);
  console.log(`MAKER: ${entrambiMaker} round entrambi maker | ${almenoUnTaker} con almeno un lato taker`);
})();
