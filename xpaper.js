// ═══════════════════════════════════════════════════════════════════════════
// xpaper.js — PAPER TRADING (nessun ordine reale, ma CONTABILITA' VERA)
// ═══════════════════════════════════════════════════════════════════════════
//
// Differenza da xsignal.js:
//   xsignal  ASSUME il fill se il prezzo scende <= soglia e STIMA il PnL
//   xpaper   VERIFICA se il fill ci sarebbe stato davvero (size reale nel book),
//            usa il PREZZO REALE dell'ask, sottrae la FEE REALE del mercato,
//            e tiene un PORTAFOGLIO con saldo, posizioni e storico trade.
//
// Fix WebSocket (rispetto alla prima versione):
//   - KEEP-ALIVE: ping ogni 10 s (Polymarket chiude se non riceve traffico)
//   - nessun socket doppio: il vecchio viene terminato prima di riaprire
//   - timeout sull'apertura: se non apre entro 15 s, riprova
//   - riconnessione con backoff, senza timer sovrapposti
//
// REGOLA (identica al bot che monteremo):
//   quota 0.44 · 5 share per lato · stop 0.35
//   aspetta finche' il lato comprato sta >= 0.35 (minimo 15 s di osservazione)
//   se perdente < 0.35 e vincente <= 0.70 -> ROTAZIONE, altrimenti STOP

import WebSocket from "ws";
import fs from "fs";
import path from "path";

// ─── CONFIGURAZIONE ────────────────────────────────────────────────────────
const CFG = {
  QUOTA: 0.44,
  SHARES: 5,
  STOP: 0.35,
  SOGLIA_PERDENTE: 0.35,
  TETTO_VINCENTE: 0.70,
  MIN_DECISION_S: 15,
  MAX_ATTESA_S: 120,
  MIN_SIZE_FILL: 5,
  MIN_SIZE_USCITA: 5,
  CAPITALE_INIZIALE: 100,
  POLL_MS: 1000,
  OUT_DIR: "out-paper",
  // WebSocket
  WS_URL: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  WS_PING_MS: 10000,       // keep-alive
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

// ─── STATO DEL PORTAFOGLIO ─────────────────────────────────────────────────
const wallet = {
  capitale: CFG.CAPITALE_INIZIALE,
  realizzato: 0,
  trade: [],
  roundOperati: 0,
  roundSaltati: 0,
};

// ─── TROVA IL ROUND E LA FEE ───────────────────────────────────────────────
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

// ─── BOOK REALE (WebSocket robusto) ────────────────────────────────────────
class BookReader {
  constructor(tokens) {
    this.tokens = tokens;
    this.books = new Map();
    this.ws = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.openTimer = null;
    this.chiuso = false;
    this.wsCaduto = 0;        // contatore, utile nei log
  }

  start() {
    if (this.chiuso) return;

    // 1. chiudi SEMPRE il socket vecchio: niente socket doppi
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.terminate(); } catch (_) {}
      this.ws = null;
    }
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.openTimer);

    try {
      this.ws = new WebSocket(CFG.WS_URL);
    } catch (e) {
      log("[ws] errore creazione:", e.message);
      this._riprova();
      return;
    }

    // 2. timeout di apertura: se non apre, riprova
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
      // 3. KEEP-ALIVE: senza ping Polymarket chiude
      this.pingTimer = setInterval(() => {
        try {
          if (this.ws && this.ws.readyState === 1) this.ws.ping();
        } catch (_) {}
      }, CFG.WS_PING_MS);
    });

    this.ws.on("pong", () => { /* connessione viva */ });

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

    this.ws.on("error", () => { /* gestito dal close */ });
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
    // fallback REST se il WS non ha ancora consegnato il book
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

// ─── SIMULAZIONE DEL FILL ──────────────────────────────────────────────────
function simulaFill(book, quota, shares) {
  if (!book || !book.asks.length) return { fillato: false, sizeDisponibile: 0 };
  let rimaste = shares, speso = 0, sizeDisponibile = 0;
  for (const [p, s] of book.asks) {
    if (p > quota) continue;
    sizeDisponibile += s;
    if (rimaste <= 0) continue;
    const q = Math.min(rimaste, s);
    speso += q * p;
    rimaste -= q;
  }
  if (rimaste > 0) return { fillato: false, sizeDisponibile, prezzo: null };
  return { fillato: true, prezzo: speso / shares, size: shares, sizeDisponibile };
}

// ─── FEE ───────────────────────────────────────────────────────────────────
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
  let decisione = null, deciso = false;

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

    // 1. FILL (verificato sul book reale)
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

    // 2. COPPIA
    if (fillUp && fillDn && !decisione) {
      const speso = fillUp.prezzo * CFG.SHARES + fillDn.prezzo * CFG.SHARES;
      const fee = fillUp.fee + fillDn.fee;
      const netto = CFG.SHARES * 1.0 - speso - fee;
      decisione = { tipo: "COPPIA", a_secondi: +t.toFixed(1), pnl: r2(netto) };
      log(`[PAPER] COPPIA chiusa @${t.toFixed(1)}s | speso ${r2(speso)} · fee ${r2(fee)} → NETTO ${netto >= 0 ? "+" : ""}${r2(netto)}`);
    }

    // 3. DECISIONE (dopo il tempo minimo)
    if (!decisione && !deciso && t >= CFG.MIN_DECISION_S) {
      const dentroUp = fillUp !== null, dentroDn = fillDn !== null;
      if (dentroUp !== dentroDn) {
        const comprato = dentroUp ? "UP" : "DN";
        const mancato  = dentroUp ? "DN" : "UP";
        const bookComprato = dentroUp ? up : dn;
        const bookMancato  = dentroUp ? dn : up;
        const pComp = bookComprato.bestBid;
        const pManc = bookMancato.bestAsk;
        const sizeUscita = bookComprato.bids.length ? bookComprato.bids[0][1] : 0;
        const scaduto = t >= CFG.MAX_ATTESA_S;

        if ((pComp !== null && pComp < CFG.SOGLIA_PERDENTE) || scaduto) {
          const ruota = (pComp !== null && pComp < CFG.SOGLIA_PERDENTE) &&
                        (pManc !== null && pManc <= CFG.TETTO_VINCENTE) &&
                        (sizeUscita >= CFG.MIN_SIZE_USCITA);
          if (ruota) {
            const fillV = simulaFill(bookMancato, pManc, CFG.SHARES);
            if (fillV.fillato) {
              const fillP = dentroUp ? fillUp : fillDn;
              const incasso = CFG.SHARES * pComp;
              const spesaV = CFG.SHARES * fillV.prezzo;
              const feeV = feeSuFill(fillV.prezzo, CFG.SHARES, r.feeRate);
              const feeP = feeSuFill(pComp, CFG.SHARES, r.feeRate);
              decisione = {
                tipo: "ROT", a_secondi: +t.toFixed(1),
                comprato, mancato,
                prezzo_perdente: r2(pComp), prezzo_vincente: r2(fillV.prezzo),
                _incasso_perdente: incasso, _spesa_vincente: spesaV,
                _speso_comprato: fillP.prezzo * CFG.SHARES,
                _fee: feeV + feeP,
              };
              log(`[PAPER] ROTAZIONE @${t.toFixed(1)}s: vendi ${comprato}@${r2(pComp)} (size ${Math.round(sizeUscita)}), compra ${mancato}@${r2(fillV.prezzo)}`);
            }
          } else {
            const fillP = dentroUp ? fillUp : fillDn;
            const uscita = CFG.SHARES * (pComp ?? 0);
            const speso = fillP.prezzo * CFG.SHARES;
            const fee = fillP.fee + feeSuFill(pComp ?? 0, CFG.SHARES, r.feeRate);
            decisione = {
              tipo: "STOP", a_secondi: +t.toFixed(1),
              comprato, prezzo_perdente: pComp !== null ? r2(pComp) : null,
              prezzo_vincente: pManc !== null ? r2(pManc) : null,
              _pnl: r2(uscita - speso - fee),
            };
            log(`[PAPER] STOP @${t.toFixed(1)}s: ${comprato} a ${pComp !== null ? r2(pComp) : "n/d"} → uscita ${r2(uscita)}`);
          }
          deciso = true;
        }
      }
    }

    if (Math.floor(t) % 60 === 0 && Math.abs(t - Math.round(t)) < 0.6) {
      log(`  t=${t.toFixed(0)}s | UP ask ${up.bestAsk} (${Math.round(up.askSize)}) | DN ask ${dn.bestAsk} (${Math.round(dn.askSize)})`);
    }
    await sleep(CFG.POLL_MS);
  }

  reader.stop();

  // 4. LIQUIDAZIONE
  const ultimo = tick[tick.length - 1] || {};
  const upFinale = ultimo.up ?? null, dnFinale = ultimo.dn ?? null;

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
    else if (decisione.tipo === "ROT") {
      // CHI HA VINTO: lo decidiamo dal prezzo finale (il lato a 1,00 e' il vincitore)
      let vincente = null;
      if (upFinale !== null && dnFinale !== null) {
        vincente = upFinale > dnFinale ? "UP" : "DN";
      }
      const haVinto = vincente === decisione.mancato;
      const valoreVincente = haVinto ? CFG.SHARES * 1.0 : 0;
      pnlRound = r2((decisione._incasso_perdente ?? 0)
                    + valoreVincente
                    - (decisione._spesa_vincente ?? 0)
                    - (decisione._speso_comprato ?? 0)
                    - (decisione._fee ?? 0));
      tipo = `ROT-${haVinto ? "OK" : "KO"}`;
      decisione.vincente_reale = vincente;
      decisione.pnl = pnlRound;
    }
    else if (decisione.tipo === "STOP") { pnlRound = decisione._pnl; tipo = "STOP"; }
    else { pnlRound = decisione._pnl; tipo = "FINE"; }
  }

  if (pnlRound !== null) {
    wallet.realizzato += pnlRound;
    wallet.capitale = r2(CFG.CAPITALE_INIZIALE + wallet.realizzato);
    wallet.roundOperati++;
    wallet.trade.push({ slug: r.slug, tipo, pnl: pnlRound, decisione: decisione?.a_secondi ?? null });
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
  log("\n════ RIEPILOGO PAPER ════");
  log(`round operati: ${wallet.roundOperati} | saltati: ${wallet.roundSaltati}`);
  log(`capitale: ${CFG.CAPITALE_INIZIALE} → ${wallet.capitale} $`);
  log(`PnL realizzato: ${wallet.realizzato >= 0 ? "+" : ""}${r2(wallet.realizzato)} $`);
  if (wallet.roundOperati) log(`per round: ${r2(wallet.realizzato / wallet.roundOperati)} $`);
  for (const [k, v] of Object.entries(perTipo)) {
    log(`  ${k}: ${v.n} round · ${v.pnl >= 0 ? "+" : ""}${r2(v.pnl)} $`);
  }
  log("════════════════════════");
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  log("═══════════════════════════════════════════════════════");
  log("  xpaper — PAPER TRADING (nessun ordine reale)");
  log("═══════════════════════════════════════════════════════");
  log(`  quota ${CFG.QUOTA} · ${CFG.SHARES} share per lato · stop ${CFG.STOP}`);
  log(`  decisione: min ${CFG.MIN_DECISION_S}s · perdente <${CFG.SOGLIA_PERDENTE} e vincente <=${CFG.TETTO_VINCENTE} → ROT`);
  log(`  capitale fittizio: ${CFG.CAPITALE_INIZIALE} $`);
  log(`  ws: ping ogni ${CFG.WS_PING_MS / 1000}s · timeout apertura ${CFG.WS_OPEN_TIMEOUT_MS / 1000}s`);
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
