require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const { ClobClient, Side, OrderType } = require("@polymarket/clob-client");
const { ethers } = require("ethers");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";
const CHAIN = 137;

const PREZZO      = 0.47;
const SIZE_USDC   = 2.35;
const MIN_SIZE    = 5;
const ATTESA_FILL = 60000;
const STOP_SELL   = 0.35;
const POLL_MS     = 1500;
const DURATA_MIN  = 70;
const FEE_CRYPTO  = 0.07;
const FEE_BPS     = 1000;
const SIGNATURE_TYPE = 0;
const FUNDER = "0xaD6A5E97Ed597BEE1556aCD5A2148dc1fa89a244";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function clob() {
  const w = new ethers.Wallet(process.env.PRIVATE_KEY);
  console.log(`[wallet] firmatario: ${w.address}`);

  const creds = {
    key:        process.env.POLY_API_KEY,
    secret:     process.env.POLY_API_SECRET,
    passphrase: process.env.POLY_API_PASSPHRASE,
  };
  console.log(`[auth] creds key: ${creds.key ? creds.key.slice(0, 8) + "..." : "MANCANTE"}`);

  return new ClobClient(CLOB, CHAIN, w, creds, SIGNATURE_TYPE, FUNDER);
}

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
    return { bid: bids[0].p, ask: asks[0].p, bidSize: bids[0].s, askSize: asks[0].s };
  } catch { return null; }
}

async function infoMercato(conditionId) {
  if (!conditionId) return null;
  try {
    const r = await fetch(`${CLOB}/clob-markets/${conditionId}`);
    if (!r.ok) return null;
    const j = await r.json();
    return { minSize: j.mos ?? null };
  } catch { return null; }
}

async function ordineLimite(cli, token, price, usdc) {
  const size = +(usdc / price).toFixed(2);
  const o = await cli.createOrder({ tokenID: token, price, size, side: Side.BUY, feeRateBps: FEE_BPS });
  const res = await cli.postOrder(o, OrderType.GTC);
  return res && res.orderID ? { id: res.orderID, size } : null;
}

async function ordineVendita(cli, token, price, size) {
  const o = await cli.createOrder({ tokenID: token, price, size, side: Side.SELL, feeRateBps: FEE_BPS });
  const res = await cli.postOrder(o, OrderType.GTC);
  return res && res.orderID ? res.orderID : null;
}

async function fillDi(cli, orderId) {
  try {
    const o = await cli.getOrder(orderId);
    if (!o) return 0;
    return parseFloat(o.size_matched || 0);
  } catch { return 0; }
}

async function annulla(cli, orderId) {
  if (!orderId) return;
  try { await cli.cancelOrder({ orderID: orderId }); } catch {}
}

async function giocaRound(cli, mkt) {
  console.log(`\n=== ${mkt.slug} | ${mkt.question} ===`);

  const info = await infoMercato(mkt.conditionId);
  if (info && info.minSize && info.minSize > MIN_SIZE) {
    console.log(`  SALTO: minSize ${info.minSize} > ${MIN_SIZE}`);
    return { slug: mkt.slug, esito: "SALTATO" };
  }

  const [bUp0, bDn0] = await Promise.all([book(mkt.upToken), book(mkt.downToken)]);
  const upMaker = bUp0 ? bUp0.ask > PREZZO : null;
  const dnMaker = bDn0 ? bDn0.ask > PREZZO : null;
  console.log(`  APERTURA | UP ${bUp0 ? bUp0.ask : "?"} = ${upMaker ? "MAKER" : "TAKER"} | DN ${bDn0 ? bDn0.ask : "?"} = ${dnMaker ? "MAKER" : "TAKER"}`);

  const oUp = await ordineLimite(cli, mkt.upToken, PREZZO, SIZE_USDC);
  const oDn = await ordineLimite(cli, mkt.downToken, PREZZO, SIZE_USDC);
  console.log(`  ordini: UP@${PREZZO} ${oUp ? oUp.id : "FALLITO"} | DN@${PREZZO} ${oDn ? oDn.id : "FALLITO"}`);

  if (!oUp && !oDn) return { slug: mkt.slug, esito: "ORDINI_RIFIUTATI" };
  if (!oUp || !oDn) {
    if (oUp) await annulla(cli, oUp.id);
    if (oDn) await annulla(cli, oDn.id);
    return { slug: mkt.slug, esito: "UN_ORDINE_SOLO" };
  }

  const t0 = Date.now();
  let fUp = 0, fDn = 0, stopFatto = false;

  while (Date.now() < mkt.fine) {
    await sleep(POLL_MS);
    if (!fUp) fUp = await fillDi(cli, oUp.id);
    if (!fDn) fDn = await fillDi(cli, oDn.id);
    if (fUp && fDn) break;

    if ((fUp || fDn) && !stopFatto && (Date.now() - t0) > ATTESA_FILL) {
      stopFatto = true;
      await annulla(cli, (fUp ? oDn : oUp).id);
      const id = await ordineVendita(cli, fUp ? mkt.upToken : mkt.downToken, STOP_SELL, fUp ? oUp.size : oDn.size);
      console.log(`  STOP: vendita a ${STOP_SELL} (${id})`);
    }
  }

  let esito, pnlLordo = null, fee = 0, pnlNetto = null;
  if (fUp && fDn) {
    esito = "COPPIA";
    pnlLordo = +(1 - PREZZO - PREZZO).toFixed(4);
    if (upMaker === false) fee += PREZZO * (1 - PREZZO) * FEE_CRYPTO;
    if (dnMaker === false) fee += PREZZO * (1 - PREZZO) * FEE_CRYPTO;
    fee = +fee.toFixed(5);
    pnlNetto = +(pnlLordo - fee).toFixed(4);
  } else if (fUp || fDn) {
    esito = "UN_LATO_STOPPATO";
    pnlLordo = +(STOP_SELL - PREZZO).toFixed(4);
    pnlNetto = pnlLordo;
  } else esito = "NESSUN_FILL";

  console.log(`  ESITO: ${esito}${pnlLordo !== null ? ` | lordo ${pnlLordo} | fee ${fee} | NETTO ${pnlNetto}` : ""}`);
  console.log(`  FILL REALI: UP ${fUp} share | DOWN ${fDn} share`);

  return { slug: mkt.slug, esito, pnlLordo, fee, pnlNetto, fillUp: fUp, fillDown: fDn };
}

(async () => {
  const cli = clob();

  const fine = Date.now() + DURATA_MIN * 60000;
  const fatti = new Set();
  const risultati = [];

  while (Date.now() < fine) {
    const mkt = await trovaRound();
    if (!mkt) { await sleep(1000); continue; }
    if (fatti.has(mkt.slug)) { await sleep(1000); continue; }

    try {
      const r = await giocaRound(cli, mkt);
      fatti.add(mkt.slug);
      risultati.push(r);
      await supabase.from("signals").insert([{
        category: "btc-maker-live",
        market_title: r.slug,
        condition_id: mkt.conditionId || null,
        signal_type: r.esito,
        detail: JSON.stringify(r),
        edge: r.pnlNetto ?? null,
        live: r.esito === "COPPIA",
      }]);
    } catch (e) { console.error("errore round:", e.message); }

    const attesa = mkt.fine - Date.now() + 300;
    if (attesa > 0) await sleep(attesa);
  }

  const coppie = risultati.filter(r => r.esito === "COPPIA");
  const netto  = risultati.reduce((t, r) => t + (r.pnlNetto || 0), 0);

  console.log(`\n════ RIEPILOGO ════`);
  console.log(`round: ${risultati.length} | COPPIA ${coppie.length}`);
  console.log(`PnL NETTO: ${netto.toFixed(3)}`);
})();
