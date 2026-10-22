// ═══════════════════════════════════════════════════════════════════════════
// xpaper.js — PAPER TRADING · v4.1
// ═══════════════════════════════════════════════════════════════════════════
//
// COSA AGGIUNGE LA v4.1 RISPETTO ALLA v4
//
//   1. RIMETTE l'esito nel log: COPPIA / UN_LATO, piu' UP min e DN min.
//      Senza quelle righe non si puo' confrontare con gli altri bot.
//
//   2. FILL AL PRIMO LIVELLO, non alla media.
//      Prima: un ask a 0.10 con piu' livelli dava un "fill" a 0.25 -> falso.
//      Adesso: il fill e' al prezzo del primo livello utile, quello che in
//      live prenderesti davvero.
//
//   3. STOP GESTITO CON IL PREZZO REALE (il bid corrente).
//      Se entro a 0.25 e il prezzo scende a 0.09, lo stop a 0.35 non esiste:
//      non puoi vendere a 0.35 quello che il mercato paga 0.09.
//
//   4. MAKER / TAKER e FEE PAGATE, in ogni round.
//      - TAKER: compri contro l'ask -> il prezzo e' quello del book
//      - MAKER: il fill avviene al livello esatto della quota
//      Viene mostrata la fee pagata con il totale cumulato.
//
// REGOLA
//   quota 0.44 su UP e DN · 5 share per lato
//   attesa lunga: la coppia ha tutto il round per chiudersi
//   stop 0.35 (sul prezzo corrente) · nessuna rotazione

import WebSocket from "ws";
import fs from "fs";
import path from "path";

// ─── CONFIGURAZIONE ────────────────────────────────────────────────────────
const CFG = {
  QUOTA: 0.44,
  SHARES: 5,
  STOP: 0.35,
  PREZZO_MIN_FILL: 0.25,
  CAPITALE_INIZIALE: 100,
  POLL_MS: 1000,
  OUT_DIR: "out-paper",
  WS_URL: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  WS_PING_MS: 10000,
  WS_OPEN_TIMEOUT_MS: 15000,
  WS_RECONNECT_MS: 3000,
};

const GAMMA = process.env.GAMMA_API || "https://gamma-api.polymarket.com";
const CLOB  = process.env.CLOB_API  || "https://clob.polymarket.com";
const WINDOW = 300;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

async function jget(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function roundStart(now = Date.now()) {
  return Math.floor(now / 1000 / WINDOW) * WINDOW;
}

// ─── PORTAFOGLIO ───────────────────────────────────────────────────────────
const wallet = {
  capitale: CFG.CAPITALE_INIZIALE,
  realizzato: 0,
  feeP: 0,
  trade: [],
  roundOperati: 0,
  roundSaltati: 0,
};

// ─── ROUND + FEE ───────────────────────────────────────────────────────────
async function trovaRound(startTs) {
  const slug = `btc-updown-5m-${startTs}`;
  try {
    const ev = await jget(`${GAMMA}/events?slug=${slug}`);
    if (!Array.isArray(ev) || !ev.length) return null;
    const m = ev[0].markets?.[0];
    if (!m) return null;
    let tokens = m.clobTokenIds;
    if (typeof tokens === "string") tokens = JSON.parse(tokens);
    const feeBps = Number(m.feeRateBps ?? m.fee_rate_bps ?? 0) || 0;
    return {
      slug, title: ev[0].title,
      upToken: tokens?.[0] ?? null, dnToken: tokens?.[1] ?? null,
      feeRate: feeBps / 10000,
    };
  } catch (e) {
    log("[warn] gamma:", e.message);
    return null;
  }
}

// ─── BOOK ──────────────────────────────────────────────────────────────────
class BookReader {
  constructor(tokens) {
    this.tokens = tokens;
    this.books = new Map();
    this.ws = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.openTimer = null;
    this.chiuso = false;
    this.wsCaduto = 0;
  }

  start() {
    if (this.chiuso) return;
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.terminate(); } catch (_) {}
      this.ws = null;
    }
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.openTimer);

    try { this.ws = new WebSocket(CFG.WS_URL); }
    catch (e) { log("[ws] errore creazione:", e.message); this._riprova(); return; }

    this.openTimer = setTimeout(() => {
      if (this.ws && this.ws.readyState !== 1) this._riprova();
    }, CFG.WS_OPEN_TIMEOUT_MS);

    this.ws.on("open", () => {
      clearTimeout(this.openTimer);
      try {
        this.ws.send(JSON.stringify({ type: "subscribe", channel: "book", assets_ids: this.tokens }));
      } catch (_) {}
      log("[ws] connesso");
      this.pingTimer = setInterval(() => {
        try { if (this.ws && this.ws.readyState === 1) this.ws.ping(); } catch (_) {}
      }, CFG.WS_PING_MS);
    });
    this.ws.on("pong", () => {});
    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        for (const m of (Array.isArray(msg) ? msg : [msg])) {
          if (m.type === "book" || m.event_type === "book") {
            const id = m.asset_id || m.market;
            if (!id) continue;
            this.books.set(id, {
              bids: (m.bids || m.buys || []).map((b) => [parseFloat(b.price), parseFloat(b.size)]),
              asks: (m.asks || m.sells || []).map((a) => [parseFloat(a.price), parseFloat(a.size)]),
            });
          }
        }
      } catch (_) {}
    });
    this.ws.on("close", () => {
      clearInterval(this.pingTimer);
      clearTimeout(this.openTimer);
      this.wsCaduto++;
      if (this.chiuso) return;
      this._riprova();
    });
    this.ws.on("error", () => {});
  }

  _riprova() {
    if (this.chiuso) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.start(), CFG.WS_RECONNECT_MS);
  }

  stop() {
    this.chiuso = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.openTimer);
    try { this.ws?.removeAllListeners(); this.ws?.terminate(); } catch (_) {}
  }

  async leggi(tokenId) {
    if (!tokenId) return null;
    let b = this.books.get(tokenId);
    if (!b || (!b.bids.length && !b.asks.length)) {
      try {
        const r = await jget(`${CLOB}/book?token_id=${tokenId}`);
        b = {
          bids: (r.bids || []).map((x) => [parseFloat(x.price), parseFloat(x.size)]),
          asks: (r.asks || []).map((x) => [parseFloat(x.price), parseFloat(x.size)]),
        };
        this.books.set(tokenId, b);
      } catch (_) { return null; }
    }
    const bids = (b.bids || []).filter((x) => isFinite(x[0]) && isFinite(x[1]) && x[1] > 0);
    const asks = (b.asks || []).filter((x) => isFinite(x[0]) && isFinite(x[1]) && x[1] > 0);
    const sortedAsks = [...asks].sort((a, c) => a[0] - c[0]);
    const sortedBids = [...bids].sort((a, c) => c[0] - a[0]);
    return {
      bestBid: sortedBids.length ? sortedBids[0][0] : null,
      bestAsk: sortedAsks.length ? sortedAsks[0][0] : null,
      askSize: sortedAsks.length ? sortedAsks[0][1] : 0,
      asks: sortedAsks,
      bids: sortedBids,
    };
  }
}

// ─── FILL ──────────────────────────────────────────────────────────────────
// Il tuo ordine e' limit a QUOTA su entrambi i lati.
// Fill al PRIMO livello utile (non alla media dei livelli).
function simulaFill(book, quota, shares) {
  if (!book || !book.asks.length) return { fillato: false, sizeDisponibile: 0 };
  const utili = book.asks.filter(([p]) => p <= quota && p >= CFG.PREZZO_MIN_FILL);
  const sizeDisponibile = utili.reduce((s, [, size]) => s + size, 0);
  if (!utili.length) return { fillato: false, sizeDisponibile: 0 };
  const [primoPrezzo, primoSize] = utili[0];
  if (primoSize < shares) return { fillato: false, sizeDisponibile, prezzo: null };
  return { fillato: true, prezzo: primoPrezzo, size: shares, sizeDisponibile };
}

function ruoloFill(prezzoFill, quota) {
  return Math.abs(prezzoFill - quota) < 0.005 ? "MAKER" : "TAKER";
}

function feeSuFill(prezzo, shares, feeRate) {
  if (!feeRate) return 0;
  return feeRate * prezzo * (1 - prezzo) * shares;
}

// ─── UN ROUND ──────────────────────────────────────────────────────────────
async function eseguiRound(r) {
  log(`\n${"=".repeat(70)}`);
  log(`ROUND ${r.slug} | ${r.title} | fee ${(r.feeRate * 10000).toFixed(0)} bps`);

  const reader = new BookReader([r.upToken, r.dnToken].filter(Boolean));
  reader.start();

  const inizio = roundStart();
  const tick = [];
  let fillUp = null, fillDn = null;
  let decisione = null;
  let feeRound = 0;

  while (Math.floor(Date.now() / 1000) - inizio < WINDOW) {
    const t = (Date.now() - inizio * 1000) / 1000;
    const [up, dn] = await Promise.all([reader.leggi(r.upToken), reader.leggi(r.dnToken)]);
    if (!up || !dn) { await sleep(CFG.POLL_MS); continue; }

    tick.push({ t: +t.toFixed(1), up: up.bestAsk, dn: dn.bestAsk,
                askUp: up.askSize, askDn: dn.askSize,
                bidUp: up.bestBid, bidDn: dn.bestBid });

    if (!fillUp) {
      const f = simulaFill(up, CFG.QUOTA, CFG.SHARES);
      if (f.fillato) {
        const ruolo = ruoloFill(f.prezzo, CFG.QUOTA);
        const fee = feeSuFill(f.prezzo, CFG.SHARES, r.feeRate);
        fillUp = { prezzo: f.prezzo, size: CFG.SHARES, t: +t.toFixed(1), ruolo, fee };
        feeRound += fee;
        log(`  UP  FILL @${r2(f.prezzo)} (ask ${r2(up.bestAsk)}, size disp ${Math.round(f.sizeDisponibile)}) [${ruolo}] fee ${r4(fee)} a ${t.toFixed(1)}s`);
      }
    }
    if (!fillDn) {
      const f = simulaFill(dn, CFG.QUOTA, CFG.SHARES);
      if (f.fillato) {
        const ruolo = ruoloFill(f.prezzo, CFG.QUOTA);
        const fee = feeSuFill(f.prezzo, CFG.SHARES, r.feeRate);
        fillDn = { prezzo: f.prezzo, size: CFG.SHARES, t: +t.toFixed(1), ruolo, fee };
        feeRound += fee;
        log(`  DN  FILL @${r2(f.prezzo)} (ask ${r2(dn.bestAsk)}, size disp ${Math.round(f.sizeDisponibile)}) [${ruolo}] fee ${r4(fee)} a ${t.toFixed(1)}s`);
      }
    }

    if (fillUp && fillDn && !decisione) {
      const speso = fillUp.prezzo * CFG.SHARES + fillDn.prezzo * CFG.SHARES;
      const netto = CFG.SHARES * 1.0 - speso - feeRound;
      const mU = fillUp.ruolo === "MAKER" ? "MAKER" : "TAKER";
      const mD = fillDn.ruolo === "MAKER" ? "MAKER" : "TAKER";
      decisione = { tipo: "COPPIA", a_secondi: +t.toFixed(1), speso: r2(speso), fee: r4(feeRound), pnl: r2(netto) };
      log(`[PAPER] COPPIA chiusa @${t.toFixed(1)}s | ${mU}/${mD} | speso ${r2(speso)} · fee ${r4(feeRound)} → NETTO ${netto >= 0 ? "+" : ""}${r2(netto)}`);
    }

    // STOP al bid reale
    if (!decisione && (fillUp || fillDn)) {
      const dentroUp = fillUp !== null;
      const bookComprato = dentroUp ? up : dn;
      const pBid = bookComprato.bestBid;
      if (pBid !== null && pBid < CFG.STOP) {
        const comprato = dentroUp ? "UP" : "DN";
        const fillP = dentroUp ? fillUp : fillDn;
        const uscita = CFG.SHARES * pBid;
        const speso = fillP.prezzo * CFG.SHARES;
        const feeV = feeSuFill(pBid, CFG.SHARES, r.feeRate);
        feeRound += feeV;
        decisione = {
          tipo: "STOP", a_secondi: +t.toFixed(1), comprato,
          prezzo_uscita: r2(pBid), fee: r4(feeRound),
          _pnl: r2(uscita - speso - feeRound),
        };
        log(`[PAPER] STOP @${t.toFixed(1)}s: ${comprato} al bid ${r2(pBid)} (< ${CFG.STOP}) → incasso ${r2(uscita)} · fee ${r4(feeRound)}`);
      }
    }

    if (Math.floor(t) % 60 === 0 && Math.abs(t - Math.round(t)) < 0.6) {
      log(`  t=${t.toFixed(0)}s | UP ask ${up.bestAsk} (${Math.round(up.askSize)}) | DN ask ${dn.bestAsk} (${Math.round(dn.askSize)})`);
    }
    await sleep(CFG.POLL_MS);
  }

  reader.stop();

  const upMin = Math.min(...tick.map((x) => x.up ?? 9));
  const dnMin = Math.min(...tick.map((x) => x.dn ?? 9));
  const coppiaReale = upMin <= CFG.QUOTA && dnMin <= CFG.QUOTA;
  const esito = coppiaReale ? "COPPIA" : "UN_LATO";

  if (!decisione && (fillUp || fillDn)) {
    const fillP = fillUp || fillDn;
    const latoP = fillUp ? "up" : "dn";
    const ultimo = tick[tick.length - 1] || {};
    const pUscita = ultimo[latoP] ?? 0.01;
    const uscita = CFG.SHARES * pUscita;
    const speso = fillP.prezzo * CFG.SHARES;
    feeRound += feeSuFill(pUscita, CFG.SHARES, r.feeRate);
    decisione = { tipo: "FINE_ROUND", a_secondi: 300, prezzo_uscita: r2(pUscita),
                  fee: r4(feeRound), _pnl: r2(uscita - speso - feeRound) };
  }

  let pnlRound = null, tipo = "NON_OPERATO";
  if (decisione) {
    if (decisione.tipo === "COPPIA") { pnlRound = decisione.pnl; tipo = "COPPIA"; }
    else { pnlRound = decisione._pnl; tipo = decisione.tipo; }
  }

  if (pnlRound !== null) {
    wallet.realizzato += pnlRound;
    wallet.feeP += feeRound;
    wallet.capitale = r2(CFG.CAPITALE_INIZIALE + wallet.realizzato);
    wallet.roundOperati++;
    wallet.trade.push({ slug: r.slug, tipo, pnl: pnlRound, fee: r4(feeRound), esito });
  } else {
    wallet.roundSaltati++;
  }

  log(`>>> ${r.slug}`);
  log(`    esito: ${esito} | UP min: ${upMin} | DN min: ${dnMin}`);
  log(`    tipo: ${tipo} | decisione: ${decisione ? decisione.tipo + " @" + decisione.a_secondi + "s" : "nessuna"} | ws caduti: ${reader.wsCaduto}`);
  log(`    fee pagate: ${r4(feeRound)} $ (totale ${r4(wallet.feeP)} $)`);
  if (pnlRound !== null) log(`    PnL REALIZZATO: ${pnlRound >= 0 ? "+" : ""}${pnlRound} $ | SALDO: ${wallet.capitale} $`);
  else log(`    nessun fill utile → round non operato`);

  fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
  fs.appendFileSync(path.join(CFG.OUT_DIR, "paper.csv"),
    [r.slug, esito, tipo, decisione?.a_secondi ?? "",
     fillUp ? `${r2(fillUp.prezzo)}:${fillUp.ruolo}` : "",
     fillDn ? `${r2(fillDn.prezzo)}:${fillDn.ruolo}` : "",
     r4(feeRound), pnlRound ?? "", wallet.capitale].join(",") + "\n");
  fs.writeFileSync(path.join(CFG.OUT_DIR, `${r.slug}.csv`),
    "t,up_ask,up_size,dn_ask,dn_size,up_bid,dn_bid\n" +
    tick.map((x) => [x.t, x.up ?? "", Math.round(x.up ? x.askUp : 0), x.dn ?? "", Math.round(x.dn ? x.askDn : 0),
                     x.bidUp ?? "", x.bidDn ?? ""].join(",")).join("\n"));
}

// ─── RIEPILOGO ─────────────────────────────────────────────────────────────
function riepilogo() {
  const perTipo = {};
  for (const t of wallet.trade) {
    perTipo[t.tipo] = perTipo[t.tipo] ?? { n: 0, pnl: 0 };
    perTipo[t.tipo].n++; perTipo[t.tipo].pnl += t.pnl;
  }
  const coppie = wallet.trade.filter((x) => x.esito === "COPPIA").length;
  log("\n════ RIEPILOGO PAPER v4.1 ════");
  log(`round operati: ${wallet.roundOperati} | saltati: ${wallet.roundSaltati}`);
  log(`esiti reali: COPPIA ${coppie} | UN_LATO ${wallet.roundOperati - coppie}`);
  log(`capitale: ${CFG.CAPITALE_INIZIALE} → ${wallet.capitale} $`);
  log(`fee pagate: ${r4(wallet.feeP)} $`);
  log(`PnL realizzato: ${wallet.realizzato >= 0 ? "+" : ""}${r2(wallet.realizzato)} $`);
  if (wallet.roundOperati) log(`per round: ${r2(wallet.realizzato / wallet.roundOperati)} $`);
  for (const [k, v] of Object.entries(perTipo)) {
    log(`  ${k}: ${v.n} round · ${v.pnl >= 0 ? "+" : ""}${r2(v.pnl)} $`);
  }
  log("════════════════════════════");
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  log("═══════════════════════════════════════════════════════");
  log("  xpaper — PAPER TRADING · v4.1");
  log("═══════════════════════════════════════════════════════");
  log(`  quota ${CFG.QUOTA} · ${CFG.SHARES} share per lato · stop ${CFG.STOP}`);
  log(`  attesa lunga · nessuna rotazione`);
  log(`  log: esito, UP/DN min, maker/taker, fee pagate`);
  log(`  capitale fittizio: ${CFG.CAPITALE_INIZIALE} $`);
  log("═══════════════════════════════════════════════════════");

  while (true) {
    const start = roundStart();
    const r = await trovaRound(start);
    if (!r || !r.upToken || !r.dnToken) {
      log(`[wait] round ${start} non trovato`);
      await sleep(15000);
      continue;
    }
    try { await eseguiRound(r); } catch (e) { log("[err]", e.message); }
    const attesa = Math.max(1000, (start + WINDOW) * 1000 - Date.now() + 2000);
    await sleep(attesa);
  }
}

process.on("SIGINT", () => { riepilogo(); process.exit(0); });
process.on("SIGTERM", () => { riepilogo(); process.exit(0); });
main().catch((e) => { console.error(e); process.exit(1); });
