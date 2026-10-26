// ═══════════════════════════════════════════════════════════════════════════
// xfair.js v2 — PAPER TRADING · maker con PREZZO GIUSTO da BTC (Chainlink)
// v2: registra anche Coinbase e TWAP 30 s e confronta 4 varianti del prezzo giusto
//     (la strategia di trading resta la variante A, identica alla v1)
// Polymarket BTC su/giu' 5 minuti
//
// IDEA
//   Il bot vecchio quotava attorno al mid del book: imparava il prezzo dallo
//   stesso book su cui comprava, quindi arrivava sempre tardi.
//   Questo calcola da solo la probabilita' "giusta" che vinca UP, dal prezzo
//   BTC Chainlink (lo stesso che decide il mercato):
//
//     P(up) = Φ( (prezzo_ora - prezzo_inizio) / (σ · √tempo_rimasto_effettivo) )
//
//   σ = volatilita' di BTC misurata sugli ultimi minuti di tick Chainlink.
//   tempo_rimasto_effettivo tiene conto che il mercato si risolve sul TWAP
//   (media) degli ultimi 30 s, non su un singolo prezzo.
//
// COME OPERA (solo ordini limite = maker, fee 0)
//   - compra un lato solo se il suo prezzo e' almeno EDGE sotto il prezzo giusto
//     (es. giusto 0,60 → offre al massimo 0,55)
//   - sposta gli ordini appena il prezzo giusto cambia; se il feed BTC si
//     ferma per piu' di 5 s cancella tutto
//   - al massimo MAX_SHARES per lato per round; niente nuovi ordini negli
//     ultimi STOP_QUOTE_S secondi
//   - tiene le posizioni fino all'esito (letto da Gamma)
//
// CALIBRAZIONE (la cosa piu' importante da guardare)
//   Ogni 30 s salva prezzo giusto del modello e mid del mercato; a esito letto
//   confronta chi dei due prevedeva meglio (Brier: piu' basso = meglio).
//   Se il modello NON batte il mercato, non c'e' vantaggio, qualunque sia il PNL.
//
// LIMITI: fill ottimistici (primo in coda), polling del book ogni secondo,
//   prezzo di inizio = primo tick Chainlink dopo l'inizio del round.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";

// mercato: "5m" (predefinito) oppure "15m"
const MERCATO = (process.env.MERCATO || "5m").toLowerCase() === "15m" ? "15m" : "5m";
const CFG = {
  CAPITALE: 50,
  SIZE: Number(process.env.SIZE || 5),
  MAX_SHARES: Number(process.env.MAX_SHARES || 10),   // per lato per round
  EDGE: Number(process.env.EDGE || 0.05),              // sconto minimo sul prezzo giusto
  REQUOTE_TOL: 0.01,
  PREZZO_MIN: 0.05,
  PREZZO_MAX: 0.95,
  STOP_QUOTE_S: Number(process.env.STOP_QUOTE_S || (MERCATO === "15m" ? 120 : 60)), // niente ordini negli ultimi N s
  TWAP_S: MERCATO === "15m" ? 60 : 30,   // media di risoluzione: 30 s per i 5 minuti, 60 s per i 15 minuti
  VOL_FINESTRA_S: 600,
  VOL_DEFAULT: 7e-5,        // σ per √secondo (≈ 0,12% su 5 minuti)
  VOL_MIN: 2e-5,
  FEED_MAX_RITARDO_S: 5,
  VARIANTE: (process.env.VARIANTE || "G").toUpperCase(),
  MAX_DISACCORDO: Number(process.env.MAX_DISACCORDO || 0.15),  // se modello e book differiscono di piu', non compra   // con quale prezzo giusto opera: E o A
  LATENZA_S: Number(process.env.LATENZA_S || 2),     // ritardo stimato del bot (polling 1 s + rete)
  K_SALTO: Number(process.env.K_SALTO || 3),          // edge extra = K_SALTO × salto possibile in LATENZA_S
  ROUNDS: Number(process.env.ROUNDS || 10),
  POLL_MS: 1000,
  CAMPIONE_S: 30,
  ESITO_DOPO_S: 90,
  ESITO_OGNI_S: 10,
  ESITO_MAX_S: 900,
  OUT_DIR: process.env.OUT_DIR || (MERCATO === "15m" ? "out-fair15" : "out-fair"),
  RTDS: "wss://ws-live-data.polymarket.com",
};
const WINDOW = MERCATO === "15m" ? 900 : 300;
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const r4 = (x) => Math.round(x * 10000) / 10000;
const r2 = (x) => Math.round(x * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Date.now() / 1000;
fs.mkdirSync(path.join(CFG.OUT_DIR, "tick"), { recursive: true });
const LOGF = path.join(CFG.OUT_DIR, "log.txt");
function log(...a) {
  const s = new Date().toISOString().slice(11, 19) + " " + a.join(" ");
  console.log(s);
  fs.appendFileSync(LOGF, s + "\n");
}
function csv(nome, head, righe) {
  const f = path.join(CFG.OUT_DIR, nome);
  if (!fs.existsSync(f)) fs.writeFileSync(f, head + "\n");
  if (righe.length) fs.appendFileSync(f, righe.map((r) => r.join(",")).join("\n") + "\n");
}
async function jget(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

// ─── normale cumulativa ────────────────────────────────────────────────────
function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// ─── FEED PREZZI BTC (RTDS di Polymarket) ──────────────────────────────────
//   cl = Chainlink spot (quello che usa il bot per operare)
//   bn = Coinbase BTC-USD (piu' veloce, per misurare il ritardo di Chainlink)
//   tw = Chainlink TWAP 30 s (per capire qual e' il vero prezzo di partenza)
class Feed {
  constructor(nome) { this.nome = nome; this.tick = []; }
  push(ts, prezzo) {                       // ts in secondi
    if (!isFinite(ts) || !isFinite(prezzo) || prezzo <= 0) return;
    const ultimo = this.tick[this.tick.length - 1];
    if (ultimo && ts <= ultimo[0]) return;
    this.tick.push([ts, prezzo]);
    const limite = ts - 2 * CFG.VOL_FINESTRA_S;
    while (this.tick.length && this.tick[0][0] < limite) this.tick.shift();
  }
  ultimo() { return this.tick[this.tick.length - 1] ?? null; }
  fresco() { const u = this.ultimo(); return u && nowS() - u[0] <= CFG.FEED_MAX_RITARDO_S ? u : null; }
  primoDopo(ts) { return this.tick.find((x) => x[0] >= ts) ?? null; }
  alTempo(ts) {                             // ultimo tick a ts o prima (ricerca binaria)
    let lo = 0, hi = this.tick.length - 1, ris = null;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (this.tick[m][0] <= ts) { ris = this.tick[m]; lo = m + 1; } else hi = m - 1;
    }
    return ris;
  }
  media(da, a) {
    const pts = this.tick.filter((x) => x[0] >= da && x[0] <= a);
    if (!pts.length) return null;
    return pts.reduce((s, x) => s + x[1], 0) / pts.length;
  }
  vol() {                                  // σ per √secondo, sugli ultimi minuti
    const u = this.ultimo(); if (!u) return CFG.VOL_DEFAULT;
    const pts = this.tick.filter((x) => x[0] >= u[0] - CFG.VOL_FINESTRA_S);
    if (pts.length < 30) return CFG.VOL_DEFAULT;
    let s2 = 0;
    for (let i = 1; i < pts.length; i++) s2 += Math.log(pts[i][1] / pts[i - 1][1]) ** 2;
    const dt = pts[pts.length - 1][0] - pts[0][0];
    return dt > 0 ? Math.max(CFG.VOL_MIN, Math.sqrt(s2 / dt)) : CFG.VOL_DEFAULT;
  }
}
const FEED = new Feed("cl");
const BN = new Feed("bn");
const TW = new Feed("tw");

// differenza media Chainlink - Coinbase negli ultimi 2 minuti (le due quotazioni
// non coincidono: aggregato di piu' fonti contro un singolo exchange)
function base() {
  const u = FEED.ultimo(); if (!u) return null;
  const d = [];
  for (const [ts, p] of FEED.tick) {
    if (ts < u[0] - 120) continue;
    const b = BN.alTempo(ts);
    if (b && ts - b[0] <= 5) d.push(p - b[1]);
  }
  if (d.length < 5) {
    // ripiego: ultimo Chainlink contro il Coinbase piu' vicino nel tempo
    const b = BN.alTempo(u[0]);
    return b && u[0] - b[0] <= 10 ? u[1] - b[1] : null;
  }
  d.sort((a, c) => a - c);
  return d[Math.floor(d.length / 2)];
}
// stima di dove sara' Chainlink, usando Coinbase che arriva prima
function clStimato() {
  const b = BN.fresco(), k = base();
  return b && k !== null ? [b[0], b[1] + k] : null;
}

function startFeeds() {
  let grezzi = 0;
  const avvia = () => import("ws").then((m) => {
    const ws = new m.default(CFG.RTDS);
    let ping = null;
    ws.on("open", () => {
      ws.send(JSON.stringify({ action: "subscribe", subscriptions: [
        { topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol: "btc/usd" }) },
        { topic: MERCATO === "15m" ? "crypto_prices_twap_sixty" : "crypto_prices_twap_thirty", type: "*", filters: JSON.stringify({ symbol: "btc/usd" }) },
      ] }));
      log("[feed] connesso a RTDS: chainlink btc/usd + twap 30s");
      ping = setInterval(() => { try { ws.send("PING"); } catch (_) {} }, 5000);
    });
    const visti = new Set();
    ws.on("message", (raw) => {
      const s = raw.toString();
      let m; try { m = JSON.parse(s); } catch (_) { return; }
      const topic = String(m?.topic || "");
      const chiave = topic + "|" + (Array.isArray(m?.payload?.data) ? "pacchetto" : "aggiornamento");
      if (grezzi < 8 && !visti.has(chiave)) { visti.add(chiave); grezzi++; log(`[feed] primo ${chiave}: ${s.slice(0, 300)}`); }
      const p = m?.payload; if (!p) return;
      const feed = topic === "crypto_prices_chainlink" ? FEED : topic === "crypto_prices" ? BN
                 : topic.startsWith("crypto_prices_twap") ? TW : null;
      if (!feed) return;
      const sym = String(p.symbol || "").toLowerCase();
      if (sym && sym !== "btc/usd" && sym !== "btcusdt" && sym !== "btcusd") return;
      const conv = (ts) => (ts > 1e12 ? ts / 1000 : ts);
      const val = (v) => { v = Number(v); return v > 1e12 ? v / 1e18 : v; };   // TWAP legacy in E18
      if (Array.isArray(p.data)) for (const d of p.data) feed.push(conv(Number(d.timestamp)), val(d.value));
      else if (p.value !== undefined) feed.push(conv(Number(p.timestamp ?? m.timestamp)), val(p.full_accuracy_value ?? p.value));
    });
    ws.on("close", () => { clearInterval(ping); log("[feed] chiuso, riconnessione"); setTimeout(avvia, 2000); });
    ws.on("error", (e) => log("[feed] errore:", e.message));
  }).catch((e) => log("[feed] modulo ws mancante:", e.message));
  avvia();
  avviaCoinbase();
}

// Coinbase BTC-USD: prezzo degli scambi in tempo reale (piu' veloce di Chainlink)
function avviaCoinbase() {
  let primo = true, ultimoPush = 0;
  import("ws").then((m) => {
    const ws = new m.default("wss://ws-feed.exchange.coinbase.com");
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] }));
      log("[feed] connesso a Coinbase: ticker BTC-USD");
    });
    ws.on("message", (raw) => {
      let d; try { d = JSON.parse(raw.toString()); } catch (_) { return; }
      if (primo) { primo = false; log(`[feed] primo messaggio Coinbase: ${raw.toString().slice(0, 200)}`); }
      if (d.type !== "ticker" || !d.price || !d.time) return;
      const ts = Date.parse(d.time) / 1000;
      if (ts - ultimoPush < 0.2) return;          // al massimo 5 prezzi al secondo
      ultimoPush = ts;
      BN.push(ts, Number(d.price));
    });
    ws.on("close", () => { log("[feed] Coinbase chiuso, riconnessione"); setTimeout(avviaCoinbase, 2000); });
    ws.on("error", (e) => log("[feed] Coinbase errore:", e.message));
  }).catch((e) => log("[feed] modulo ws mancante:", e.message));
}

// prezzo giusto di UP, con prezzo di partenza e prezzo attuale scelti
function fairCore(r, t, inizio, cur, sigma = FEED.vol()) {
  if (!cur || !inizio || nowS() - cur[0] > CFG.FEED_MAX_RITARDO_S) return null;
  const tau = Math.max(0, WINDOW - t);
  const W = CFG.TWAP_S;
  let atteso, varianza;
  if (tau >= W) {
    atteso = cur[1];
    varianza = sigma ** 2 * (tau - W + W / 3) * cur[1] ** 2;
  } else {
    const fatto = W - tau;
    const mediaFatta = FEED.media(r.start + WINDOW - W, nowS()) ?? cur[1];
    atteso = (mediaFatta * fatto + cur[1] * tau) / W;
    varianza = sigma ** 2 * (tau ** 3) / (3 * W * W) * cur[1] ** 2;
  }
  const diff = atteso - inizio;
  if (varianza <= 0) return { p: diff >= 0 ? 0.999 : 0.001, salto: 0 };
  const z = diff / Math.sqrt(varianza);
  const quotaFutura = tau >= W ? 1 : tau / W;
  const dS = cur[1] * sigma * Math.sqrt(CFG.LATENZA_S) * quotaFutura;
  const densita = 0.3989422804014327 * Math.exp(-z * z / 2);
  return { p: Math.min(0.999, Math.max(0.001, phi(z))), salto: Math.min(0.5, densita * dS / Math.sqrt(varianza)) };
}
// volatilita' misurata su Coinbase, campionata a 1 secondo (Chainlink cambia a scatti
// e fa sembrare BTC piu' calmo di quanto e')
function volCoinbase() {
  const u = BN.ultimo(); if (!u) return null;
  let s2 = 0, n = 0, prec = null;
  for (let ts = Math.floor(u[0]) - CFG.VOL_FINESTRA_S; ts <= u[0]; ts++) {
    const p = BN.alTempo(ts); if (!p) continue;
    if (prec) { s2 += Math.log(p[1] / prec) ** 2; n++; }
    prec = p[1];
  }
  return n >= 60 ? Math.max(CFG.VOL_MIN, Math.sqrt(s2 / n)) : null;
}
// prezzo giusto con cui il bot OPERA
//   variante E (predefinita): partenza = primo tick Chainlink del round (verificato: coincide
//     con il Price to Beat ufficiale FINALE in 20 round su 20; quello letto dall'endpoint nei
//     primi secondi e' provvisorio e spesso sbagliato), attuale = stimato da Coinbase,
//     volatilita' da Coinbase. Se Coinbase non c'e', ripiega sulla variante A
function prezzoGiusto(r, t) {
  let f = null;
  if (CFG.VARIANTE === "E") f = fairCore(r, t, r.prezzoInizio, clStimato(), volCoinbase() ?? FEED.vol());
  // variante G (predefinita): partenza = media Chainlink (TWAP) all'inizio del round. Sui round
  // risolti spiega l'esito ufficiale meglio del tick mostrato sul sito (83/87 contro 78/87;
  // 8 casi su 8 dove le due regole divergono)
  if (CFG.VARIANTE === "G" && r.inizioTwap) f = fairCore(r, t, r.inizioTwap, clStimato(), volCoinbase() ?? FEED.vol());
  if (!f) f = fairCore(r, t, r.prezzoInizio, FEED.ultimo());
  prezzoGiusto.salto = f ? f.salto : 0;
  return f ? f.p : null;
}
// tutte e 4 le varianti, per il confronto
//   A: partenza Chainlink   · attuale Chainlink
//   B: partenza Chainlink   · attuale stimato da Coinbase
//   C: partenza TWAP 30 s   · attuale Chainlink
//   D: partenza TWAP 30 s   · attuale stimato da Coinbase
//   E: partenza Chainlink · attuale da Coinbase · volatilita' Coinbase (quella usata)
//   F: partenza media (TWAP) · attuale da Coinbase · volatilita' Coinbase (= variante G, quella usata)
function varianti(r, t) {
  const cl = FEED.ultimo(), st = clStimato();
  const g = (ini, cur, sig) => { const f = fairCore(r, t, ini, cur, sig ?? FEED.vol()); return f ? r4(f.p) : null; };
  return { A: g(r.prezzoInizio, cl), B: g(r.prezzoInizio, st), C: g(r.inizioTwap, cl), D: g(r.inizioTwap, st),
           E: g(r.prezzoInizio, st, volCoinbase()), F: g(r.inizioTwap, st, volCoinbase()) };
}

// Price to Beat e prezzo finale ufficiali (quelli mostrati sulla pagina del mercato)
let ptbGrezzi = 0;
async function ptbPolymarket(start) {
  const iso = (s) => new Date(s * 1000).toISOString().replace(".000Z", "Z");
  const url = `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=${iso(start)}&variant=${MERCATO === "15m" ? "fifteenminute" : "fiveminute"}&endDate=${iso(start + WINDOW)}`;
  try {
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" } });
    const testo = await r.text();
    if (ptbGrezzi < 3) { ptbGrezzi++; log(`   [ptb] risposta ${r.status}: ${testo.slice(0, 200)}`); }
    if (!r.ok) return null;
    const j = JSON.parse(testo);
    const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
    return { open: num(j.openPrice), close: num(j.closePrice), completo: !!j.completed };
  } catch (e) { if (ptbGrezzi < 3) { ptbGrezzi++; log(`   [ptb] errore: ${e.message}`); } return null; }
}
prezzoGiusto.salto = 0;

// ─── portafoglio con flussi per round ──────────────────────────────────────
const PF = { contante: CFG.CAPITALE, posizioni: [], flussi: new Map() };
function muovi(slug, importo) {
  PF.contante = r4(PF.contante + importo);
  PF.flussi.set(slug, r4((PF.flussi.get(slug) || 0) + importo));
}
function ordine(o) {
  csv("ordini.csv", "slug,t,lato,azione,prezzo,size,importo,giusto,contante_dopo",
    [[o.slug, o.t, o.lato, o.azione, r4(o.prezzo), o.size, r4(o.importo), o.giusto ?? "", PF.contante]]);
  if (o.azione !== "PIAZZA" && o.azione !== "ANNULLA")
    log(`   ${o.azione.padEnd(14)} ${o.lato} ${o.size}@${r4(o.prezzo)}${o.giusto != null ? ` (giusto ${r4(o.giusto)})` : ""} = ${o.importo >= 0 ? "+" : ""}${r4(o.importo)} $ | contante ${r2(PF.contante)}`);
}

async function trovaRound(start) {
  const slug = `btc-updown-${MERCATO}-${start}`;
  const ev = await jget(`${GAMMA}/events?slug=${slug}`);
  const m = ev?.[0]?.markets?.[0];
  if (!m) return null;
  const tok = parse(m.clobTokenIds);
  const oc = parse(m.outcomes).map((s) => String(s).toLowerCase());
  const iUp = oc.findIndex((s) => s.startsWith("up"));
  if (iUp < 0 || !tok?.[iUp] || !tok?.[1 - iUp]) return null;
  return { slug, start, up: tok[iUp], dn: tok[1 - iUp] };
}
async function book(token) {
  try {
    const b = await jget(`${CLOB}/book?token_id=${token}`);
    const lv = (a) => (a || []).map((x) => [parseFloat(x.price), parseFloat(x.size)]).filter((x) => x[1] > 0 && isFinite(x[0]));
    const asks = lv(b.asks).sort((a, c) => a[0] - c[0]);
    const bids = lv(b.bids).sort((a, c) => c[0] - a[0]);
    return { ask: asks[0]?.[0] ?? null, bid: bids[0]?.[0] ?? null };
  } catch (_) { return null; }
}

// ─── esiti ─────────────────────────────────────────────────────────────────
const SOSPESI = [];
async function esitoGamma(slug) {
  const ev = await jget(`${GAMMA}/events?slug=${slug}`);
  const m = ev?.[0]?.markets?.[0];
  if (!m || m.closed !== true) return null;
  const pr = parse(m.outcomePrices).map(Number);
  const oc = parse(m.outcomes).map((s) => String(s).toLowerCase());
  if (pr.length !== 2) return null;
  const iWin = pr.indexOf(1);
  if (iWin < 0 || pr[1 - iWin] !== 0) return null;
  return { lato: oc[iWin].startsWith("up") ? "up" : "dn", prezzi: pr.join("/") };
}
const HEAD_ROUND = "slug,esito,prezzo_inizio,fill_up,fill_dn,costo,edge_medio,pnl,brier_modello,brier_mercato,campioni,ptb_ufficiale,finale_ufficiale,inizio_twap30,twap30_fine,media_cl30_fine";
async function risolvi() {
  for (const s of [...SOSPESI]) {
    const eta = nowS() - s.fine;
    if (eta < CFG.ESITO_DOPO_S || nowS() - s.ultimoTentativo < CFG.ESITO_OGNI_S) continue;
    s.ultimoTentativo = nowS();
    let e = null;
    try { e = await esitoGamma(s.r.slug); } catch (_) {}
    if (!e) {
      if (eta > CFG.ESITO_MAX_S) {
        SOSPESI.splice(SOSPESI.indexOf(s), 1);
        csv("round.csv", HEAD_ROUND, [[s.r.slug, "NON_RISOLTO", s.r.prezzoInizio ?? "", s.fillUp, s.fillDn, s.costo, s.edgeMedio, "", "", "", "", "", "", "", "", ""]]);
        log(`NON RISOLTO ${s.r.slug} — escluso dal PNL`);
      }
      continue;
    }
    for (const p of [...PF.posizioni.filter((x) => x.slug === s.r.slug)]) {
      const inc = p.lato === e.lato ? p.size : 0;
      muovi(p.slug, inc);
      PF.posizioni.splice(PF.posizioni.indexOf(p), 1);
      ordine({ slug: p.slug, t: WINDOW, lato: p.lato, azione: p.lato === e.lato ? "SCADENZA_VINTA" : "SCADENZA_PERSA", prezzo: inc ? 1 : 0, size: p.size, importo: inc });
    }
    const pnl = r4(PF.flussi.get(s.r.slug) || 0);
    const y = e.lato === "up" ? 1 : 0;
    const fine = s.r.start + WINDOW;
    const uff = await ptbPolymarket(s.r.start);
    const tw30 = TW.alTempo(fine)?.[1] ?? null, clMedia = FEED.media(fine - CFG.TWAP_S, fine);
    if (uff) log(`   UFFICIALE ${s.r.slug}: price to beat ${uff.open} · finale ${uff.close} · nostro: inizio CL ${r2(s.r.prezzoInizio ?? NaN)} · TWAP${CFG.TWAP_S} a fine ${r2(tw30 ?? NaN)} · media CL ${CFG.TWAP_S}s ${r2(clMedia ?? NaN)}`);
    const bm = s.campioni.length ? r4(s.campioni.reduce((a, c) => a + (c.giusto - y) ** 2, 0) / s.campioni.length) : "";
    const bk = s.campioni.length ? r4(s.campioni.reduce((a, c) => a + (c.mid - y) ** 2, 0) / s.campioni.length) : "";
    csv("calibrazione.csv", "slug,t,A,B,C,D,E,F,mid_up,esito_up", s.campioni.map((c) => [s.r.slug, c.t, c.v.A ?? "", c.v.B ?? "", c.v.C ?? "", c.v.D ?? "", c.v.E ?? "", c.v.F ?? "", c.mid, y]));
    SOSPESI.splice(SOSPESI.indexOf(s), 1);
    csv("round.csv", HEAD_ROUND, [[s.r.slug, e.lato, s.r.prezzoInizio ?? "", s.fillUp, s.fillDn, s.costo, s.edgeMedio, pnl, bm, bk, s.campioni.length,
      uff?.open ?? "", uff?.close ?? "", s.r.inizioTwap ?? "", tw30 ?? "", clMedia ?? ""]]);
    log(`ESITO ${s.r.slug}: ${e.lato} | fill up ${s.fillUp} dn ${s.fillDn} | PNL ${pnl >= 0 ? "+" : ""}${pnl} | Brier modello ${bm} vs mercato ${bk}`);
  }
}

// ─── un round ──────────────────────────────────────────────────────────────
async function round(r) {
  log(`\n══════ ROUND ${r.slug} (${new Date(r.start * 1000).toISOString().slice(11, 19)} UTC)`);
  const ap = { up: null, dn: null };            // ordine aperto per lato
  const preso = { up: 0, dn: 0 };               // share comprate nel round
  const edges = [];
  const campioni = [];
  const tick = [];
  let ultimoCampione = -999, ultimoLog = -999, avvisoFeed = false;

  const annulla = (l, t) => { if (!ap[l]) return; ordine({ slug: r.slug, t, lato: l, azione: "ANNULLA", prezzo: ap[l].prezzo, size: ap[l].size, importo: 0 }); ap[l] = null; };

  while (nowS() - r.start < WINDOW - 0.5) {
    const t = r4(nowS() - r.start);
    if (!r.prezzoInizio) {
      const p0 = FEED.primoDopo(r.start);
      if (p0 && p0[0] - r.start < 10) {
        r.prezzoInizio = p0[1];
        const tw = TW.alTempo(r.start), bn = BN.alTempo(r.start), k = base();
        if (tw && r.start - tw[0] <= 5) r.inizioTwap = tw[1];
        log(`   prezzo di inizio: Chainlink ${r2(p0[1])} (+${r4(p0[0] - r.start)}s) · TWAP${CFG.TWAP_S} ${tw ? r2(tw[1]) + ` (${r4(tw[0] - r.start)}s)` : "n/d"} · Coinbase ${bn ? r2(bn[1]) : "n/d"} · differenza CL-Coinbase ${k !== null ? r2(k) : "n/d"}`);
      }
      else if (t > 10) { log(`   ⚠ nessun prezzo di inizio entro 10 s: round saltato`); break; }
    }
    if (!r.ptb && t >= 2 && t < 150 && nowS() - (r.ptbUltimo || 0) >= 5) {
      r.ptbUltimo = nowS();
      ptbPolymarket(r.start).then((x) => {
        if (x && x.open && !r.ptb) {
          r.ptb = x.open;   // solo per il registro: NON usato per operare (e' provvisorio)
          log(`   price to beat PROVVISORIO ${r2(x.open)} (+${Math.round(nowS() - r.start)}s) · nostro Chainlink ${r2(r.prezzoInizio ?? NaN)} (diff ${r2(x.open - (r.prezzoInizio ?? NaN))}) · TWAP${CFG.TWAP_S} ${r2(r.inizioTwap ?? NaN)} (diff ${r2(x.open - (r.inizioTwap ?? NaN))})`);
        }
      });
    }
    const [up, dn] = await Promise.all([book(r.up), book(r.dn)]);
    const gUp = prezzoGiusto(r, t);
    if (up && dn) tick.push([t.toFixed(1), gUp ?? "", up.bid ?? "", up.ask ?? "", dn.bid ?? "", dn.ask ?? "", FEED.ultimo()?.[1] ?? "", r2(clStimato()?.[1] ?? NaN) || "", TW.ultimo()?.[1] ?? ""]);

    if (gUp === null) {
      if (r.prezzoInizio && !avvisoFeed) { log(`   ⚠ feed BTC fermo: cancello gli ordini`); avvisoFeed = true; }
      annulla("up", t); annulla("dn", t);
    } else if (up && dn) {
      avvisoFeed = false;
      const giusto = { up: gUp, dn: 1 - gUp };
      const bk = { up, dn };

      // 1) fill PRIMA di spostare gli ordini (l'ask che scende sul tuo ordine lo colpisce)
      for (const l of ["up", "dn"]) {
        const o = ap[l], b = bk[l];
        if (o && b.ask !== null && b.ask <= o.prezzo) {
          const costo = r4(o.prezzo * o.size);
          if (costo <= PF.contante + 1e-9) {
            muovi(r.slug, -costo);
            PF.posizioni.push({ slug: r.slug, lato: l, prezzo: o.prezzo, size: o.size });
            preso[l] += o.size;
            edges.push(r4(giusto[l] - o.prezzo));
            ordine({ slug: r.slug, t, lato: l, azione: "FILL_MAKER", prezzo: o.prezzo, size: o.size, importo: -costo, giusto: giusto[l] });
          }
          ap[l] = null;
        }
      }

      // 2) quotazione
      const fineQuote = WINDOW - t < CFG.STOP_QUOTE_S;
      for (const l of ["up", "dn"]) {
        const b = bk[l];
        if (fineQuote || preso[l] >= CFG.MAX_SHARES || b.ask === null) { annulla(l, t); continue; }
        // filtro: un disaccordo troppo grande col mercato di solito vuol dire che sbagliamo noi
        if (b.bid !== null && Math.abs(giusto[l] - (b.bid + b.ask) / 2) > CFG.MAX_DISACCORDO) { annulla(l, t); continue; }
        const edgeEff = CFG.EDGE + CFG.K_SALTO * prezzoGiusto.salto;  // piu' largo se il giusto corre
        let p = Math.floor((giusto[l] - edgeEff) * 100) / 100;       // tick 0,01
        p = Math.min(p, r4(b.ask - 0.01));                             // resta maker
        if (p < CFG.PREZZO_MIN || p > CFG.PREZZO_MAX) { annulla(l, t); continue; }
        if (ap[l] && Math.abs(ap[l].prezzo - p) < CFG.REQUOTE_TOL - 1e-9) continue;
        annulla(l, t);
        ap[l] = { prezzo: p, size: CFG.SIZE };
        ordine({ slug: r.slug, t, lato: l, azione: "PIAZZA", prezzo: p, size: CFG.SIZE, importo: 0, giusto: giusto[l] });
      }

      // 3) campioni per la calibrazione
      if (t - ultimoCampione >= CFG.CAMPIONE_S && up.bid !== null && up.ask !== null) {
        ultimoCampione = t;
        campioni.push({ t: Math.round(t), giusto: r4(gUp), mid: r4((up.bid + up.ask) / 2), v: varianti(r, t) });
      }
      if (t - ultimoLog >= 60) {
        ultimoLog = t;
        const vv = varianti(r, t);
        const eta = (f) => { const u = f.ultimo(); return u ? `${f.tick.length} tick, ultimo ${r2(nowS() - u[0])}s fa` : "nessun tick"; };
        log(`   [${Math.round(t)}s] feed · Chainlink ${eta(FEED)} · Coinbase ${eta(BN)} · TWAP ${eta(TW)} · differenza CL-Coinbase ${base() !== null ? r2(base()) : "n/d"}`);
        log(`   [${Math.round(t)}s] giusto A/B/C/D ${vv.A}/${vv.B ?? "-"}/${vv.C ?? "-"}/${vv.D ?? "-"} · CL ${r2(FEED.ultimo()?.[1])} stimato ${r2(clStimato()?.[1] ?? NaN)}`);
        log(`   [${Math.round(t)}s] BTC ${FEED.ultimo()?.[1]} (inizio ${r.prezzoInizio}) σ ${FEED.vol().toExponential(2)} · giusto up ${r4(gUp)} · book up ${up.bid}/${up.ask} dn ${dn.bid}/${dn.ask} · ordini ${ap.up?.prezzo ?? "-"}/${ap.dn?.prezzo ?? "-"} · preso up ${preso.up} dn ${preso.dn}`);
      }
    }
    await risolvi();
    await sleep(CFG.POLL_MS);
  }
  annulla("up", r4(nowS() - r.start)); annulla("dn", r4(nowS() - r.start));
  fs.writeFileSync(path.join(CFG.OUT_DIR, "tick", `${r.slug}.csv`),
    "t,giusto_up,up_bid,up_ask,dn_bid,dn_ask,btc_chainlink,chainlink_stimato_da_coinbase,twap30\n" + tick.map((x) => x.join(",")).join("\n") + "\n");
  const costo = r4(-(PF.flussi.get(r.slug) || 0));
  const edgeMedio = edges.length ? r4(edges.reduce((a, b) => a + b, 0) / edges.length) : "";
  log(`   fine round · preso up ${preso.up} dn ${preso.dn} · speso ${costo} $ · edge medio ai fill ${edgeMedio || "-"} → esito tra ${CFG.ESITO_DOPO_S}s`);
  if (!r.prezzoInizio && !preso.up && !preso.dn) return false;
  SOSPESI.push({ r, fine: r.start + WINDOW, ultimoTentativo: 0, fillUp: preso.up, fillDn: preso.dn, costo, edgeMedio, campioni });
  return true;
}

// ─── riepilogo ─────────────────────────────────────────────────────────────
function riepilogo() {
  const f = path.join(CFG.OUT_DIR, "round.csv");
  const righe = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")) : [];
  const ok = righe.filter((x) => x[1] === "up" || x[1] === "dn");
  const conFill = ok.filter((x) => Number(x[3]) + Number(x[4]) > 0);
  const pnl = r4(ok.reduce((s, x) => s + Number(x[7]), 0));
  const fc = path.join(CFG.OUT_DIR, "calibrazione.csv");
  const cal = fs.existsSync(fc) ? fs.readFileSync(fc, "utf8").trim().split("\n").slice(1)
    .map((l) => l.split(",").map((v, i) => (i === 0 ? v : v === "" ? null : Number(v)))) : [];
  // colonne: 0 slug, 1 t, 2 A, 3 B, 4 C, 5 D, 6 E, 7 F, 8 mid, 9 esito
  const COL = { A: 2, B: 3, C: 4, D: 5, E: 6, F: 7 };
  const NOMI = { A: "partenza CL · attuale CL", B: "partenza CL · attuale da Coinbase",
                 C: "partenza TWAP · attuale CL", D: "partenza TWAP · attuale da Coinbase",
                 E: "partenza CL · Coinbase + vol Coinbase", F: "partenza MEDIA · Coinbase + vol Coinbase (G) *" };
  const righeBrier = Object.entries(COL).map(([k, i]) => {
    const c = cal.filter((x) => x[i] !== null && x[8] !== null);
    if (!c.length) return `  ${k} ${NOMI[k].padEnd(40)} nessun dato`;
    const bm = r4(c.reduce((a, x) => a + (x[i] - x[9]) ** 2, 0) / c.length);
    const bk = r4(c.reduce((a, x) => a + (x[8] - x[9]) ** 2, 0) / c.length);
    return `  ${k} ${NOMI[k].padEnd(40)} modello ${bm} vs mercato ${bk} (${c.length} campioni)${bm < bk ? "  ← batte il mercato" : ""}`;
  });
  const fasce = [];
  for (let i = 0; i < 10; i++) {
    const c = cal.filter((x) => x[2] !== null && x[2] >= i / 10 && x[2] < (i + 1) / 10 + (i === 9 ? 1e-9 : 0));
    if (c.length) fasce.push(`  giusto A ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}: ${String(c.length).padStart(4)} campioni · UP vinto ${r2(100 * c.reduce((a, x) => a + x[9], 0) / c.length)}%`);
  }
  const fermi = r4(PF.posizioni.reduce((s, p) => s + p.prezzo * p.size, 0));
  const saldo = r4(PF.contante + fermi), atteso = r4(CFG.CAPITALE + pnl);
  const txt = [
    `xfair v3.2 · mercato ${MERCATO} · opera con la variante ${CFG.VARIANTE} (paper, fill ottimistici)`,
    `capitale ${CFG.CAPITALE} · size ${CFG.SIZE} · edge ${CFG.EDGE} · max ${CFG.MAX_SHARES}/lato · disaccordo max ${CFG.MAX_DISACCORDO}`,
    `round_risolti ${ok.length} (con fill ${conFill.length}) · non_risolti ${righe.length - ok.length + SOSPESI.length}`,
    `pnl ${pnl} · per round ${ok.length ? r4(pnl / ok.length) : 0} · round in profitto ${conFill.filter((x) => Number(x[7]) > 0).length}/${conFill.length}`,
    "",
    `CALIBRAZIONE (${cal.length} campioni) — Brier: piu' basso = previsione migliore`,
    ...righeBrier,
    "  → una variante che non batte il mercato non da' vantaggio  (* = quella con cui opera il bot)",
    ...fasce,
    "",
    `contante ${PF.contante} · posizioni aperte al costo ${fermi} · saldo ${saldo} · atteso ${atteso} · quadratura ${Math.abs(atteso - saldo) < 0.005 ? "OK" : "FALLITA"}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(CFG.OUT_DIR, "riepilogo.txt"), txt);
  log("\n══════ RIEPILOGO\n" + txt);
}

async function main() {
  log(`══ xfair v3.2 · mercato ${MERCATO} · variante ${CFG.VARIANTE} · disaccordo max ${CFG.MAX_DISACCORDO} · ${CFG.ROUNDS} round · edge ${CFG.EDGE} · size ${CFG.SIZE} · max ${CFG.MAX_SHARES}/lato · stop quote ultimi ${CFG.STOP_QUOTE_S}s`);
  startFeeds();
  let fatti = 0, ultimoStart = null, tentativi = 0;
  while (fatti < CFG.ROUNDS) {
    if (++tentativi > CFG.ROUNDS * 2) { log(`[stop] troppi round saltati (feed BTC o Gamma non disponibili): esco`); break; }
    let prossimo = Math.ceil(nowS() / WINDOW) * WINDOW;
    if (ultimoStart !== null && nowS() < ultimoStart + WINDOW + 10) prossimo = ultimoStart + WINDOW;
    ultimoStart = prossimo;
    log(`[attesa] prossimo round alle ${new Date(prossimo * 1000).toISOString().slice(11, 19)} UTC · tick BTC ricevuti ${FEED.tick.length}`);
    while (nowS() < prossimo - 0.2) { await risolvi(); await sleep(Math.min(5000, Math.max(200, (prossimo - nowS()) * 1000 - 200))); }
    let r = null;
    for (let k = 0; k < 5 && !r; k++) {
      try { r = await trovaRound(prossimo); } catch (e) { log("[warn] gamma:", e.message); }
      if (!r) await sleep(1000);
    }
    if (!r) { log(`[salto] round ${prossimo} non trovato`); continue; }
    try { if (await round(r)) fatti++; } catch (e) { log("[err] round:", e.stack || e.message); }
  }
  log(`[fine] attendo gli esiti di ${SOSPESI.length} round...`);
  while (SOSPESI.length) { await risolvi(); await sleep(2000); }
  riepilogo();
  process.exit(0);
}
process.on("SIGINT", () => { riepilogo(); process.exit(0); });
process.on("SIGTERM", () => { riepilogo(); process.exit(0); });
if (!process.env.XFAIR_NO_MAIN) main().catch((e) => { log("[fatale]", e.stack || e.message); process.exit(1); });
export { CFG, FEED, BN, TW, PF, varianti, base, round, risolvi, riepilogo, SOSPESI, prezzoGiusto, phi };
