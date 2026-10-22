// ═══════════════════════════════════════════════════════════════════════════
// xpaper.js — PAPER TRADING · v4 (VERSIONE DEFINITIVA)
// ═══════════════════════════════════════════════════════════════════════════
//
// COSA FA
//   Simula l'operativita' sul book REALE di Polymarket, senza piazzare ordini.
//   Verifica i fill sulla size vera, usa il prezzo vero dell'ask, la fee vera
//   del mercato, e tiene un portafoglio con saldo e storico.
//
// REGOLA (fissata sui dati, non stimata)
//   quota 0.44 su UP e DN · 5 share per lato
//   NON si stoppa per tempo: la coppia ha tutto il round per chiudersi
//   stop SOLO se il lato comprato scende sotto 0.35
//   nessuna rotazione
//
// PERCHE' QUESTI NUMERI
//
//   STOP = 0.35 (non 0.20)
//     Calcolo sui dati: da +0.20 $ a stop 0.05 fino a +6.20 $ a stop 0.35
//     su 13 round. Piu' alto e' lo stop, minore e' la perdita realizzata:
//       stop 0.05 -> perdi 0.39/share -> -1.95 $
//       stop 0.20 -> perdi 0.24/share -> -1.20 $
//       stop 0.35 -> perdi 0.09/share -> -0.45 $
//     I round a un lato finiscono comunque sotto 0.05: aspettare non costa.
//
//   ATTESA LUNGA (nessuna soglia temporale)
//     Nei log: 14 round in cui il secondo lato e' entrato DOPO lo stop
//     (a 36, 63, 68, 78, 84, 86, 97, 99, 104, 121, 167, 171, 231, 245 s).
//     Con stop a 15 s erano coppie perse; con l'attesa lunga sono incassate.
//     Dai CSV: attesa 30 s -> +0.01 $/round · attesa 240 s -> +0.48 $/round
//
//   NIENTE ROTAZIONE
//     19 tentativi nei log, 19 persi. Comprare a 0.67 ha valore atteso zero
//     (0.66 * 5.00 = 3.30 contro una spesa di 3.35). Non e' sfortuna, e' prezzo.
//
// NUMERI ECONOMICI
//   2,35 $ per lato · coppia 4,70 $ · incasso 5,00 $ · profitto coppia +0,30 $
//   costo reale misurato: coppie a 3,50-4,40 $ -> profitto +0,60 a +1,50 $

import WebSocket from "ws";
import fs from "fs";
import path from "path";

// ─── CONFIGURAZIONE ────────────────────────────────────────────────────────
const CFG = {
  QUOTA: 0.44,             // quota di ingresso su UP e DN
  SHARES: 5,               // share per lato
  STOP: 0.35,              // stop sul lato comprato (v4: era 0.20)
  PREZZO_MIN_FILL: 0.25,   // sotto questo non e' un fill reale
  CAPITALE_INIZIALE: 100,
  POLL_MS: 1000,
  OUT_DIR: "out-paper",
  WS_URL: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  WS_PING_MS: 10000,       // keep-alive: senza, Polymarket chiude
  WS_OPEN_TIMEOUT_MS: 15000,
  WS_RECONNECT_MS: 3000,
};

const GAMMA = process.env.GAMMA_API || "https://gamma-api.polymarket.com";
const CLOB  = process.env.CLOB_API  || "https://clob.polymarket.com";
const WINDOW = 300;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => Math.round(x * 100) / 100;

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

// ─── BOOK (WebSocket robusto) ──────────────────────────────────────────────
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
      if (this.ws && this.ws.readyState !== 1) {
        log("[ws] timeout apertura, riprovo");
        this._riprova();
      }
    }, CFG.WS_OPEN_TIMEOUT_MS);

    this.ws.on("open", () => {
      clearTimeout(this.openTimer);
      try {
        this.ws.send(JSON.stringify({
          type: "subscribe", channel: "book", assets_ids: this.tokens,
        }));
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
      log(`[ws] chiuso (#${this.wsCaduto}), riconnessione fra ${CFG.WS_RECONNECT_MS / 1000}s`);
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

// ─── FILL SIMULATO ─────────────────────────────────────────────────────────
// Compra contro gli ask <= quota. Scarta i livelli a prezzo morto (< 0.25):
// un "fill" a 0.01 non e' un fill, e' il book svuotato a fine round.
// Il prezzo di fill e' la MEDIA dei livelli consumati, e deve stare sopra
// PREZZO_MIN_FILL.
function simulaFill(book, quota, shares) {
  if (!book || !book.asks.length) return { fillato: false, sizeDisponibile: 0 };
  const utili = book.asks.filter(([p]) => p <= quota && p >= CFG.PREZZO_MIN_FILL);
  const sizeDisponibile = utili.reduce((s, [, size]) => s + size, 0);
  if (sizeDisponibile < shares) return { fillato: false, sizeDisponibile, prezzo: null };

  let rimaste = shares, speso = 0;
  for (const [p, s] of utili) {
    if (rimaste <= 0) break;
    const q = Math.min(rimaste, s);
    speso += q * p;
    rimaste -= q;
  }
  if (rimaste > 0) return { fillato: false, sizeDisponibile, prezzo: null };
  const prezzo = speso / shares;
  if (prezzo < CFG.PREZZO_MIN_FILL) return { fillato: false, sizeDisponibile, prezzo: null };
  return { fillato: true, prezzo, size: shares, sizeDisponibile };
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

  while (Math.floor(Date.now() / 1000) - inizio < WINDOW) {
    const t = (Date.now() - inizio * 1000) / 1000;

    const [up, dn] = await Promise.all([reader.leggi(r.upToken), reader.leggi(r.dnToken)]);
    if (!up || !dn) { await sleep(CFG.POLL_MS); continue; }

    tick.push({
      t: +t.toFixed(1),
      up: up.bestAsk, dn: dn.bestAsk,
      askUp: up.askSize, askDn: dn.askSize,
      bidUp: up.bestBid, bidDn: dn.bestBid,
    });

    // FILL — si tenta fino alla fine del round
    if (!fillUp) {
      const f = simulaFill(up, CFG.QUOTA, CFG.SHARES);
      if (f.fillato) {
        fillUp = { prezzo: f.prezzo, size: CFG.SHARES, t: +t.toFixed(1),
                   fee: feeSuFill(f.prezzo, CFG.SHARES, r.feeRate) };
        log(`  UP FILL @${r2(f.prezzo)} (ask ${r2(up.bestAsk)}, size disp ${Math.round(f.sizeDisponibile)}) a ${t.toFixed(1)}s`);
      }
    }
    if (!fillDn) {
      const f = simulaFill(dn, CFG.QUOTA, CFG.SHARES);
      if (f.fillato) {
        fillDn = { prezzo: f.prezzo, size: CFG.SHARES, t: +t.toFixed(1),
                   fee: feeSuFill(f.prezzo, CFG.SHARES, r.feeRate) };
        log(`  DN FILL @${r2(f.prezzo)} (ask ${r2(dn.bestAsk)}, size disp ${Math.round(f.sizeDisponibile)}) a ${t.toFixed(1)}s`);
      }
    }

    // COPPIA — appena entrambi sono dentro, il round e' in profitto
    if (fillUp && fillDn && !decisione) {
      const speso = fillUp.prezzo * CFG.SHARES + fillDn.prezzo * CFG.SHARES;
      const fee = fillUp.fee + fillDn.fee;
      const netto = CFG.SHARES * 1.0 - speso - fee;
      decisione = { tipo: "COPPIA", a_secondi: +t.toFixed(1), speso: r2(speso), pnl: r2(netto) };
      log(`[PAPER] COPPIA chiusa @${t.toFixed(1)}s | speso ${r2(speso)} · fee ${r2(fee)} → NETTO ${netto >= 0 ? "+" : ""}${r2(netto)}`);
    }

    // STOP — solo se il lato comprato scende sotto CFG.STOP (0.35)
    if (!decisione && (fillUp || fillDn)) {
      const dentroUp = fillUp !== null;
      const bookComprato = dentroUp ? up : dn;
      const pBid = bookComprato.bestBid;
      if (pBid !== null && pBid < CFG.STOP) {
        const comprato = dentroUp ? "UP" : "DN";
        const fillP = dentroUp ? fillUp : fillDn;
        const uscita = CFG.SHARES * CFG.STOP;   // esco AL LIVELLO dello stop
        const speso = fillP.prezzo * CFG.SHARES;
        const fee = fillP.fee + feeSuFill(CFG.STOP, CFG.SHARES, r.feeRate);
        decisione = {
          tipo: "STOP", a_secondi: +t.toFixed(1),
          comprato, prezzo_uscita: CFG.STOP,
          _pnl: r2(uscita - speso - fee),
        };
        log(`[PAPER] STOP @${t.toFixed(1)}s: ${comprato} sceso a ${r2(pBid)} (< ${CFG.STOP}) → uscita a ${CFG.STOP} = ${r2(uscita)}`);
      }
    }

    if (Math.floor(t) % 60 === 0 && Math.abs(t - Math.round(t)) < 0.6) {
      log(`  t=${t.toFixed(0)}s | UP ask ${up.bestAsk} (${Math.round(up.askSize)}) | DN ask ${dn.bestAsk} (${Math.round(dn.askSize)})`);
    }
    await sleep(CFG.POLL_MS);
  }

  reader.stop();

  // LIQUIDAZIONE a fine round se e' rimasto un solo lato
  const ultimo = tick[tick.length - 1] || {};
  if (!decisione && (fillUp || fillDn)) {
    const fillP = fillUp || fillDn;
    const latoP = fillUp ? "up" : "dn";
    const prezzoUscita = ultimo[latoP] ?? 0.01;
    const uscita = CFG.SHARES * prezzoUscita;
    const speso = fillP.prezzo * CFG.SHARES;
    decisione = { tipo: "FINE_ROUND", a_secondi: 300, _pnl: r2(uscita - speso - fillP.fee) };
  }

  let pnlRound = null, tipo = "NON_OPERATO";
  if (decisione) {
    if (decisione.tipo === "COPPIA") { pnlRound = decisione.pnl; tipo = "COPPIA"; }
    else { pnlRound = decisione._pnl; tipo = decisione.tipo; }
  }

  if (pnlRound !== null) {
    wallet.realizzato += pnlRound;
    wallet.capitale = r2(CFG.CAPITALE_INIZIALE + wallet.realizzato);
    wallet.roundOperati++;
    wallet.trade.push({ slug: r.slug, tipo, pnl: pnlRound });
  } else {
    wallet.roundSaltati++;
  }

  log(`>>> ${r.slug}`);
  log(`    tipo: ${tipo} | decisione: ${decisione ? decisione.tipo + " @" + decisione.a_secondi + "s" : "nessuna"} | ws caduti: ${reader.wsCaduto}`);
  if (pnlRound !== null) log(`    PnL REALIZZATO: ${pnlRound >= 0 ? "+" : ""}${pnlRound} $ | SALDO: ${wallet.capitale} $`);
  else log(`    nessun fill utile → round non operato`);

  fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
  fs.appendFileSync(path.join(CFG.OUT_DIR, "paper.csv"),
    [r.slug, tipo, decisione?.a_secondi ?? "", fillUp ? r2(fillUp.prezzo) : "", fillDn ? r2(fillDn.prezzo) : "",
     pnlRound ?? "", wallet.capitale, r.feeRate].join(",") + "\n");
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
  log("\n════ RIEPILOGO PAPER v4 ════");
  log(`round operati: ${wallet.roundOperati} | saltati: ${wallet.roundSaltati}`);
  log(`capitale: ${CFG.CAPITALE_INIZIALE} → ${wallet.capitale} $`);
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
  log("  xpaper — PAPER TRADING · v4");
  log("═══════════════════════════════════════════════════════");
  log(`  quota ${CFG.QUOTA} · ${CFG.SHARES} share per lato`);
  log(`  attesa lunga: la coppia ha tutto il round`);
  log(`  stop ${CFG.STOP} · nessuna rotazione`);
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
