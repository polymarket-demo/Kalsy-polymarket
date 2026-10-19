require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";

const POLL_MS     = 1500;
const SOGLIA      = 0.47;
const DURATA_MIN  = 70;
const FEE_CRYPTO  = 0.07;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function trovaRound() {
  const now = Math.floor(Date.now() / 1000);
  const base = Math.floor(now / 300) * 300;

  for (const off of [0, -300]) {
    const slug = `btc-updown-5m-${base + off}`;
    let r;
    try { r = await fetch(`${GAMMA}/events?slug=${slug}`); } catch { continue; }
    if (!r.ok) continue;
    let j; try { j = await r.json(); } catch { continue; }
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

    const sizeFino = lim => asks.filter(l => l.p <= lim).reduce((t, l) => t + l.s, 0);

    return {
      bid: bids[0].p, ask: asks[0].p,
      askSize: asks[0].s, bidSize: bids[0].s,
      size42: sizeFino(0.42), size45: sizeFino(0.45),
      size47: sizeFino(0.47), size50: sizeFino(0.50),
      livelli: asks.length,
      spread: +(asks[0].p - bids[0].p).toFixed(4),
    };
  } catch { return null; }
}

async function infoMercato(conditionId) {
  if (!conditionId) return null;
  try {
    const r = await fetch(`${CLOB}/clob-markets/${conditionId}`);
    if (!r.ok) return null;
    const j = await r.json();
    return {
      minSize: j.mos ?? null, makerFee: j.mbf ?? null,
      takerFee: j.tbf ?? null, rewards: j.r ?? null, tick: j.mts ?? null,
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
          if (isFinite(pUp) && isFinite(pDn) && (pUp > 0.95 || pDn > 0.95)) {
            return pUp > pDn ? "UP" : "DOWN";
          }
        }
      }
    }
  } catch {}
  return "?";
}

async function registraRound(mkt) {
  console.log(`\n=== ${mkt.slug} | ${mkt.question} ===`);

  const serie = [];
  let lettureOk = 0, vuote = 0, errori = 0;
  let upTocco = null, dnTocco = null;
  let minUp = 99, minDn = 99;
  let apertura = null;
  let mio35 = null, mio30 = null;
  let maxSizeUp47 = 0, maxSizeDn47 = 0;

  while (Date.now() < mkt.fine) {
    const rem = Math.max(0, (mkt.fine - Date.now()) / 60000);
    let bUp = null, bDn = null;
    try {
      [bUp, bDn] = await Promise.all([book(mkt.upToken), book(mkt.downToken)]);
    } catch { errori++; await sleep(POLL_MS); continue; }

    if (bUp === null || bDn === null) { vuote++; await sleep(POLL_MS); continue; }

    lettureOk++;
    if (bUp.ask < minUp) minUp = bUp.ask;
    if (bDn.ask < minDn) minDn = bDn.ask;
    if (bUp.size47 > maxSizeUp47) maxSizeUp47 = bUp.size47;
    if (bDn.size47 > maxSizeDn47) maxSizeDn47 = bDn.size47;

    if (!apertura) {
      apertura = { up: bUp.ask, dn: bDn.ask, rem, s47up: bUp.size47, s47dn: bDn.size47 };
      const upM = bUp.ask > SOGLIA, dnM = bDn.ask > SOGLIA;
      console.log(`  APERTURA rem ${rem.toFixed(2)}' | UP ${bUp.ask}=${upM ? "MAKER" : "TAKER"} (size47 ${bUp.size47}) | DN ${bDn.ask}=${dnM ? "MAKER" : "TAKER"} (size47 ${bDn.size47})`);
    }

    serie.push({
      rem: +rem.toFixed(2),
      up: bUp.ask, dn: bDn.ask, spread: bUp.spread,
      s42: bUp.size42, s45: bUp.size45, s47: bUp.size47, s50: bUp.size50,
      dn42: bDn.size42, dn45: bDn.size45, dn47: bDn.size47, dn50: bDn.size50,
    });

    if (!upTocco && bUp.ask <= SOGLIA) {
      upTocco = { px: bUp.ask, rem, size: bUp.size47 };
      console.log(`  UP tocca ${SOGLIA} a ${rem.toFixed(2)}' (ask ${bUp.ask}, size47 ${bUp.size47.toFixed(0)})`);
    }
    if (!dnTocco && bDn.ask <= SOGLIA) {
      dnTocco = { px: bDn.ask, rem, size: bDn.size47 };
      console.log(`  DOWN tocca ${SOGLIA} a ${rem.toFixed(2)}' (ask ${bDn.ask}, size47 ${bDn.size47.toFixed(0)})`);
    }

    if (!(upTocco && dnTocco)) {
      const mio = upTocco ? bUp.ask : (dnTocco ? bDn.ask : null);
      if (mio !== null) {
        if (mio35 === null && mio <= 0.35) mio35 = rem;
        if (mio30 === null && mio <= 0.30) mio30 = rem;
      }
    }

    if (lettureOk % 40 === 1) {
      console.log(`  rem ${rem.toFixed(1)}' | UP ${bUp.ask} s47=${bUp.size47.toFixed(0)} | DN ${bDn.ask} s47=${bDn.size47.toFixed(0)}`);
    }
    await sleep(POLL_MS);
  }

  const vincitore = await esitoDaGamma(mkt.conditionId, mkt.slug);
  const fr = await infoMercato(mkt.conditionId);

  let primo = null, salitoDiretto = null;
  if (upTocco && dnTocco) primo = upTocco.rem > dnTocco.rem ? "UP" : "DOWN";
  else if (upTocco) { primo = "UP"; salitoDiretto = "DOWN"; }
  else if (dnTocco) { primo = "DOWN"; salitoDiretto = "UP"; }

  const esito = upTocco && dnTocco ? "COPPIA"
              : (upTocco || dnTocco ? "UN_LATO" : "NIENTE_LETTURE");
  const costo = upTocco && dnTocco ? upTocco.px + dnTocco.px : null;
  const mioLato = primo;
  const ioVinto = (mioLato && vincitore !== "?") ? mioLato === vincitore : null;

  let upMaker = null, dnMaker = null, fee = 0, pnlLordo = null, pnlNetto = null;
  let sizeAlTocco = null;

  if (apertura) {
    upMaker = apertura.up > SOGLIA;
    dnMaker = apertura.dn > SOGLIA;

    if (costo !== null) {
      pnlLordo = +(1 - costo).toFixed(4);
      if (!upMaker) fee += upTocco.px * (1 - upTocco.px) * FEE_CRYPTO;
      if (!dnMaker) fee += dnTocco.px * (1 - dnTocco.px) * FEE_CRYPTO;
      fee = +fee.toFixed(5);
      pnlNetto = +(pnlLordo - fee).toFixed(4);
      sizeAlTocco = Math.min(maxSizeUp47, maxSizeDn47);
    }
  }

  console.log(`\n>>> ROUND ${mkt.slug}`);
  console.log(`    letture ok: ${lettureOk} | vuote: ${vuote} | errori: ${errori}`);
  console.log(`    UP   tocca ${SOGLIA}: ${upTocco ? upTocco.px + " @" + upTocco.rem.toFixed(2) + "'" : "NO"} (min ${minUp === 99 ? "-" : minUp})`);
  console.log(`    DOWN tocca ${SOGLIA}: ${dnTocco ? dnTocco.px + " @" + dnTocco.rem.toFixed(2) + "'" : "NO"} (min ${minDn === 99 ? "-" : minDn})`);
  console.log(`    PRIMO: ${primo || "nessuno"}${salitoDiretto ? ` | ${salitoDiretto} è SALITO` : ""}`);
  console.log(`    ESITO: ${esito}${costo ? ` | costo ${costo.toFixed(2)}` : ""}`);
  console.log(`    VINCE: ${vincitore}`);
  console.log(`    MAKER? UP ${upMaker ? "SI" : "NO"} | DN ${dnMaker ? "SI" : "NO"}`);
  if (pnlLordo !== null) console.log(`    PnL: lordo ${pnlLordo} | fee ${fee} | NETTO ${pnlNetto}`);
  console.log(`    SIZE MAX sotto 0.47: UP ${maxSizeUp47.toFixed(0)} | DN ${maxSizeDn47.toFixed(0)}`);
  if (esito === "UN_LATO") {
    console.log(`    STOP: sotto 0.35 a ${mio35 === null ? "MAI" : mio35.toFixed(2) + "'"} | sotto 0.30 a ${mio30 === null ? "MAI" : mio30.toFixed(2) + "'"}`);
  }
  if (mioLato && ioVinto !== null) console.log(`    IL MIO LATO (${mioLato}) → ${ioVinto ? "VINTO" : "PERSO"}`);
  if (fr) console.log(`    MARKET: minSize ${fr.minSize} | fee ${fr.makerFee}/${fr.takerFee} | pool ${fr.rewards ? JSON.stringify(fr.rewards) : "nessuna"}`);
  console.log(`<<<\n`);

  return {
    slug: mkt.slug, esito, costo, pnlLordo, fee, pnlNetto,
    upTocco, dnTocco, primo, salitoDiretto, vincitore, mioLato, ioVinto,
    lettureOk, vuote, errori,
    minUp: minUp === 99 ? null : minUp, minDn: minDn === 99 ? null : minDn,
    mio35, mio30, apertura, upMaker, dnMaker,
    maxSizeUp47, maxSizeDn47, sizeAlTocco, serie, feeMercato: fr,
  };
}

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

      await supabase.from("signals").insert([{
        category: "btc-maker-test",
        market_title: r.slug,
        condition_id: mkt.conditionId || null,
        signal_type: r.esito,
        detail: JSON.stringify({
          up: r.upTocco, dn: r.dnTocco, costo: r.costo,
          pnlLordo: r.pnlLordo, fee: r.fee, pnlNetto: r.pnlNetto,
          primo: r.primo, vince: r.vincitore, mioLato: r.mioLato, ioVinto: r.ioVinto,
          apertura: r.apertura, upMaker: r.upMaker, dnMaker: r.dnMaker,
          maxSizeUp47: r.maxSizeUp47, maxSizeDn47: r.maxSizeDn47, sizeAlTocco: r.sizeAlTocco,
          stop35: r.mio35, stop30: r.mio30,
          lettureOk: r.lettureOk, vuote: r.vuote, errori: r.errori,
          minUp: r.minUp, minDn: r.minDn, feeMercato: r.feeMercato,
        }),
        edge: r.pnlNetto ?? null,
        live: r.esito === "COPPIA",
      }]);

      if (r.serie.length) {
        await supabase.from("signals").insert([{
          category: "btc-tick",
          market_title: r.slug,
          condition_id: mkt.conditionId || null,
          signal_type: "tick",
          detail: JSON.stringify(r.serie),
          edge: null, live: null,
        }]);
      }
    } catch (e) { console.error("errore round:", e.message); }

    const attesa = mkt.fine - Date.now() + 300;
    if (attesa > 0) await sleep(attesa);
  }

  const coppie = risultati.filter(r => r.esito === "COPPIA");
  const unLato = risultati.filter(r => r.esito === "UN_LATO");
  const lordo = coppie.reduce((t, r) => t + (r.pnlLordo || 0), 0);
  const feeT  = coppie.reduce((t, r) => t + (r.fee || 0), 0);
  const netto = lordo - feeT;
  const sizeMed = coppie.length
    ? coppie.reduce((t, r) => t + (r.maxSizeUp47 || 0), 0) / coppie.length : 0;

  console.log(`\n════ RIEPILOGO ════`);
  console.log(`round: ${risultati.length} | COPPIA ${coppie.length} | UN_LATO ${unLato.length}`);
  console.log(`PnL LORDO ${lordo.toFixed(3)} | FEE ${feeT.toFixed(3)} | NETTO ${netto.toFixed(3)} | per round ${(netto / Math.max(1, risultati.length)).toFixed(4)}`);
  console.log(`size media sotto 0.47 sul lato UP: ${sizeMed.toFixed(0)} share`);
})();
