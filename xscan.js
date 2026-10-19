require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";

const PREZZO      = 0.47;
const STOP_SELL   = 0.35;
const FEE_CRYPTO  = 0.07;
const POLL_MS     = 1500;
const DURATA_MIN  = 70;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Trova il round appena iniziato ──────────────────────────────────────
async function trovaRound() {
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

    const fine  = new Date(m.endDate).getTime();
    const manca = (fine - Date.now()) / 60000;
    if (manca < 4.85 || manca > 5.60) continue;

    const iUp = outs.findIndex(o => /up/i.test(o));
    const iDn = outs.findIndex(o => /down/i.test(o));

    console.log(`[gamma] ROUND ${m.slug} | chiude tra ${manca.toFixed(2)}'`);
    return {
      slug: m.slug, question: m.question, fine,
      conditionId: m.conditionId,
      upToken: tok[iUp >= 0 ? iUp : 0],
      downToken: tok[iDn >= 0 ? iDn : 1],
    };
  }
  return null;
}

// ── Book completo: prezzo + SIZE CUMMULATA sotto varie soglie ──────────
async function book(tokenId) {
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
    const sizeFino = (liv, lim) => liv.filter(l => l.p <= lim).reduce((t, l) => t + l.s, 0);

    return {
      bid: bids[0].p, ask: asks[0].p,
      bidSize: bids[0].s, askSize: asks[0].s,
      // size cumulata sotto le soglie (per capire quanto regge il book)
      size42: sizeFino(asks, 0.42),
      size44: sizeFino(asks, 0.44),
      size45: sizeFino(asks, 0.45),
      size47: sizeFino(asks, 0.47),
      size50: sizeFino(asks, 0.50),
      size55: sizeFino(asks, 0.55),
      // depth totale (somma di tutti i livelli dei due lati)
      depthAskTot: asks.reduce((t, l) => t + l.s, 0),
      depthBidTot: bids.reduce((t, l) => t + l.s, 0),
      nLivelliAsk: asks.length,
      nLivelliBid: bids.length,
    };
  } catch { return null; }
}

async function infoMercato(conditionId) {
  if (!conditionId) return null;
  try {
    const r = await fetch(`${CLOB}/clob-markets/${conditionId}`);
    if (!r.ok) return null;
    const j = await r.json();
    return { minSize: j.mos ?? null, makerFee: j.mbf ?? null, takerFee: j.tbf ?? null, tickSize: j.mts ?? null };
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
  return "?";
}

// ── Registra un round: TUTTI i dati ────────────────────────────────────
async function registraRound(mkt) {
  console.log(`\n=== ${mkt.slug} | ${mkt.question} ===`);

  let lettureOk = 0, lettureVuote = 0;
  let upTocco = null, dnTocco = null;
  let minUp = 99, minDn = 99;
  let mio35 = null, mio30 = null;
  let apertura = null;
  const traccia = [];          // la curva completa del round

  while (Date.now() < mkt.fine) {
    const rem = Math.max(0, (mkt.fine - Date.now()) / 60000);
    const [bUp, bDn] = await Promise.all([book(mkt.upToken), book(mkt.downToken)]);

    if (bUp && bDn && bUp.ask !== null && bDn.ask !== null && bUp.bid !== null && bDn.bid !== null) {
      lettureOk++;
      if (bUp.ask < minUp) minUp = bUp.ask;
      if (bDn.ask < minDn) minDn = bDn.ask;

      // prima lettura = apertura (maker/taker)
      if (!apertura) {
        apertura = { upAsk: bUp.ask, dnAsk: bDn.ask, rem, upBid: bUp.bid, dnBid: bDn.bid };
        console.log(`  APERTURA rem ${rem.toFixed(2)}' | UP ${bUp.ask} = ${bUp.ask > PREZZO ? "MAKER" : "TAKER"} | DN ${bDn.ask} = ${bDn.ask > PREZZO ? "MAKER" : "TAKER"}`);
      }

      // traccia ogni lettura (curva completa per analisi offline)
      traccia.push({
        rem: +rem.toFixed(2),
        upAsk: bUp.ask, dnAsk: bDn.ask,
        upBid: bUp.bid, dnBid: bDn.bid,
        upSize47: +bUp.size47.toFixed(0), dnSize47: +bDn.size47.toFixed(0),
        upSize42: +bUp.size42.toFixed(0), dnSize42: +bDn.size42.toFixed(0),
        upSize50: +bUp.size50.toFixed(0), dnSize50: +bDn.size50.toFixed(0),
        somma: +(bUp.ask + bDn.ask).toFixed(4),
      });

      // tocchi
      if (!upTocco && bUp.ask <= PREZZO) {
        upTocco = { px: bUp.ask, rem, size47: bUp.size47, bid: bUp.bid, ask: bUp.ask };
        console.log(`  UP tocca ${PREZZO} a ${rem.toFixed(2)}' (ask ${bUp.ask}, size<=.47 ${bUp.size47.toFixed(0)})`);
      }
      if (!dnTocco && bDn.ask <= PREZZO) {
        dnTocco = { px: bDn.ask, rem, size47: bDn.size47, bid: bDn.bid, ask: bDn.ask };
        console.log(`  DOWN tocca ${PREZZO} a ${rem.toFixed(2)}' (ask ${bDn.ask}, size<=.47 ${bDn.size47.toFixed(0)})`);
      }

      // discesa del lato comprato (per lo stop)
      if (!(upTocco && dnTocco)) {
        const mioPx = upTocco ? bUp.ask : (dnTocco ? bDn.ask : null);
        if (mioPx !== null) {
          if (mio35 === null && mioPx <= STOP_SELL) mio35 = rem;
          if (mio30 === null && mioPx <= 0.30) mio30 = rem;
        }
      }

      if (lettureOk % 40 === 1) {
        console.log(`  rem ${rem.toFixed(1)}' | UP ${bUp.ask} | DN ${bDn.ask} | UP<=47 ${bUp.size47.toFixed(0)} | DN<=47 ${bDn.size47.toFixed(0)}`);
      }
    } else { lettureVuote++; }
    await sleep(POLL_MS);
  }

  const vincitore = await esitoDaGamma(mkt.conditionId, mkt.slug);
  const info = await infoMercato(mkt.conditionId);

  let primo = null, salitoDiretto = null;
  if (upTocco && dnTocco) primo = upTocco.rem > dnTocco.rem ? "UP" : "DOWN";
  else if (upTocco) { primo = "UP"; salitoDiretto = "DOWN"; }
  else if (dnTocco) { primo = "DOWN"; salitoDiretto = "UP"; }

  const esito = upTocco && dnTocco ? "COPPIA" : (upTocco || dnTocco ? "UN_LATO" : "NIENTE_LETTURE");

  // ── P&L COMPLETO ──
  const upMaker = apertura ? apertura.upAsk > PREZZO : null;
  const dnMaker = apertura ? apertura.dnAsk > PREZZO : null;

  let costo = null, pnlLordo = null, fee = 0, pnlNetto = null, sizeMinima = null;

  if (esito === "COPPIA") {
    costo = +(upTocco.px + dnTocco.px).toFixed(4);
    pnlLordo = +(1 - costo).toFixed(4);
    if (upMaker === false) fee += upTocco.px * (1 - upTocco.px) * FEE_CRYPTO;
    if (dnMaker === false) fee += dnTocco.px * (1 - dnTocco.px) * FEE_CRYPTO;
    fee = +fee.toFixed(5);
    pnlNetto = +(pnlLordo - fee).toFixed(4);
    // size minima disponibile ai due fill: quanto regge il book
    sizeMinima = Math.min(upTocco.size47, dnTocco.size47);
  } else if (esito === "UN_LATO") {
    const comp = upTocco || dnTocco;
    costo = comp.px;
    // se lo stop è eseguito a 0.35
    const stopPossibile = (upTocco ? mio35 : mio35) !== null;
    pnlLordo = stopPossibile ? +(STOP_SELL - comp.px).toFixed(4) : -comp.px;
    pnlNetto = pnlLordo;
  }

  console.log(`\n>>> ROUND ${mkt.slug}`);
  console.log(`    letture ok: ${lettureOk} | vuote: ${lettureVuote}`);
  console.log(`    UP   tocca ${PREZZO}: ${upTocco ? upTocco.px + " @ " + upTocco.rem.toFixed(2) + "min (size " + upTocco.size47.toFixed(0) + ")" : "NO"} | minimo ${minUp === 99 ? "-" : minUp}`);
  console.log(`    DOWN tocca ${PREZZO}: ${dnTocco ? dnTocco.px + " @ " + dnTocco.rem.toFixed(2) + "min (size " + dnTocco.size47.toFixed(0) + ")" : "NO"} | minimo ${minDn === 99 ? "-" : minDn}`);
  console.log(`    PRIMO: ${primo || "nessuno"}${salitoDiretto ? ` | ${salitoDiretto} è SALITO` : ""}`);
  console.log(`    ESITO: ${esito}${costo ? " | costo " + costo : ""}`);
  console.log(`    VINCE: ${vincitore}`);
  if (esito === "UN_LATO") console.log(`    STOP: sotto ${STOP_SELL} a ${mio35 === null ? "MAI" : mio35.toFixed(2) + "'"}`);
  console.log(`    MAKER? UP ${upMaker ? "SI" : "NO"} | DN ${dnMaker ? "SI" : "NO"}`);
  if (pnlLordo !== null) console.log(`    PnL: lordo ${pnlLordo} | fee ${fee} | NETTO ${pnlNetto}`);
  if (sizeMinima !== null) console.log(`    SIZE ai fill: minima ${sizeMinima.toFixed(0)} share`);
  if (info) console.log(`    MERCATO: minSize ${info.minSize} | makerFee ${info.makerFee} | takerFee ${info.takerFee} | tick ${info.tickSize}`);
  console.log(`<<<\n`);

  return {
    slug: mkt.slug, question: mkt.question, esito, costo,
    pnlLordo, fee, pnlNetto, sizeMinima,
    upTocco, dnTocco, primo, salitoDiretto, vincitore,
    mio35, mio30, apertura, upMaker, dnMaker,
    lettureOk, lettureVuote,
    minUp: minUp === 99 ? null : minUp, minDn: minDn === 99 ? null : minDn,
    info, traccia,
  };
}

// ── MAIN ────────────────────────────────────────────────────────────────
(async () => {
  const fine = Date.now() + DURATA_MIN * 60000;
  const fatti = new Set();
  const risultati = [];

  while (Date.now() < fine) {
    const mkt = await trovaRound();
    if (!mkt) { await sleep(1000); continue; }
    if (fatti.has(mkt.slug)) { await sleep(1000); continue; }

    try {
      const r = await registraRound(mkt);
      fatti.add(mkt.slug);
      risultati.push(r);

      // riga riepilogo (senza la traccia, troppo grande)
      const { traccia, ...sintesi } = r;
      await supabase.from("signals").insert([{
        category: "btc-maker-test",
        market_title: r.slug,
        condition_id: mkt.conditionId || null,
        signal_type: r.esito,
        detail: JSON.stringify(sintesi),
        edge: r.pnlNetto ?? null,
        live: r.esito === "COPPIA",
      }]);

      // curva completa in una riga a parte (per analisi size)
      if (traccia.length) {
        await supabase.from("signals").insert([{
          category: "btc-tick",
          market_title: r.slug,
          signal_type: "traccia",
          detail: JSON.stringify(traccia),
          edge: null, live: null,
        }]);
      }
    } catch (e) { console.error("errore round:", e.message); }

    const attesa = mkt.fine - Date.now() + 300;
    if (attesa > 0) await sleep(attesa);
  }

  // ── RIEPILOGO FINALE ──
  const coppie = risultati.filter(r => r.esito === "COPPIA");
  const unLato = risultati.filter(r => r.esito === "UN_LATO");
  const lordo = coppie.reduce((t, r) => t + (r.pnlLordo || 0), 0);
  const feeT = coppie.reduce((t, r) => t + (r.fee || 0), 0);
  const netto = lordo - feeT;
  const size = coppie.map(r => r.sizeMinima).filter(s => s != null);
  const sizeMedia = size.length ? size.reduce((a, b) => a + b, 0) / size.length : 0;
  const sizeMin = size.length ? Math.min(...size) : 0;

  console.log(`\n════ RIEPILOGO FINALE ════`);
  console.log(`round: ${risultati.length} | COPPIA ${coppie.length} | UN_LATO ${unLato.length}`);
  console.log(`PnL LORDO: ${lordo.toFixed(3)} | FEE: ${feeT.toFixed(3)} | NETTO: ${netto.toFixed(3)}`);
  console.log(`per round (netto): ${(netto / Math.max(1, risultati.length)).toFixed(4)}`);
  console.log(`SIZE ai fill: media ${sizeMedia.toFixed(0)} share | minima ${sizeMin.toFixed(0)} share`);
  console.log(`MAKER: ${risultati.filter(r => r.upMaker && r.dnMaker).length} entrambi | ${risultati.filter(r => r.upMaker === false || r.dnMaker === false).length} con taker`);
})();
