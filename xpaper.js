// ═══════════════════════════════════════════════════════════════════════════
// xpaper.js — PAPER TRADING · v7 · MULTI-QUOTA + MULTI-SOGLIA AGGIUNTA
// ═══════════════════════════════════════════════════════════════════════════
//
// COSA MISURA (tutto in parallelo sullo stesso round, book reale)
//
//   A) MULTI-QUOTA — a che prezzo conviene comprare i due lati
//      0.35 · 0.37 · 0.40 · 0.42 · 0.44 · 0.47
//
//   B) MULTI-SOGLIA AGGIUNTA — a che prezzo conviene aggiungere size
//      sul lato che sale
//      0.50 · 0.55 · 0.60 · 0.65 · 0.70
//
//   C) MULTI-TRAILING — a che soglia conviene chiudere l'aggiunta
//      0.70 · 0.75 · 0.80 · 0.85 · 0.90
//      Regola trailing: l'aggiunta sale fino a >= soglia, poi se
//      riscende a quella soglia -> VENDO. Se non ci arriva -> a scadenza.
//
//   Ogni combinazione (quota · soglia agg · trailing) e' un portafoglio
//   virtuale separato. Alla fine il riepilogo dice quale combinazione rende.
//
// USCITA sul lato perdente: 0.40, non prima di 60 s dall'ingresso.
// Nessuna rotazione.
//
// ═══════════════════════════════════════════════════════════════════════════

import WebSocket from "ws";
import fs from "fs";
import path from "path";

// ─── CONFIGURAZIONE ────────────────────────────────────────────────────────
const CFG = {
  QUOTE: [0.35, 0.37, 0.40, 0.42, 0.44, 0.47],
  SOGLIE_AGG: [0.50, 0.55, 0.60, 0.65, 0.70],
  TRAILINGS: [0.70, 0.75, 0.80, 0.85, 0.90],
  SHARES: 5,
  SHARES_AGG: 5,
  USCITA: 0.40,
  USCITA_MIN_S: 60,
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
const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 10000) / 10000;

async function jget(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function roundStart(now = Date.now()) {
  return Math.floor(now / 1000 / WINDOW) * WINDOW;
}

// ─── COMBINAZIONI: quota × soglia_agg × trailing ───────────────────────────
// La soglia di aggiunta "none" = nessuna aggiunta (per avere il baseline).
const COMBINAZIONI = [];
for (const q of CFG.QUOTE) {
  COMBINAZIONI.push({ id: `${q.toFixed(2)}|noagg`, quota: q, sogliaAgg: null, trailing: null });
  for (const sa of CFG.SOGLIE_AGG) {
    for (const tr of CFG.TRAILINGS) {
      COMBINAZIONI.push({ id: `${q.toFixed(2)}|${sa.toFixed(2)}|${tr.toFixed(2)}`, quota: q, sogliaAgg: sa, trailing: tr });
    }
  }
}

function nuovoWallet(c) {
  return {
    id: c.id, quota: c.quota, sogliaAgg: c.sogliaAgg, trailing: c.trailing,
    capitale: CFG.CAPITALE_INIZIALE, realizzato: 0, feeP: 0,
    coppie: 0, unLato: 0, costoTotCoppie: 0, pnlCoppie: 0, pnlUnLato: 0,
    aggOk: 0, aggKo: 0, aggTrail: 0, trade: [],
  };
}
const wallets = new Map(COMBINAZIONI.map((c) => [c.id, nuovoWallet(c)]));

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
    this.tokens = tokens; this.books = new Map(); this.ws = null;
    this.pingTimer = null; this.reconnectTimer = null; this.openTimer = null;
    this.chiuso = false; this.wsCaduto = 0;
  }

  start() {
    if (this.chiuso) return;
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.terminate(); } catch (_) {}
      this.ws = null;
    }
    clearInterval(this.pingTimer); clearTimeout(this.reconnectTimer); clearTimeout(this.openTimer);

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
      clearInterval(this.pingTimer); clearTimeout(this.openTimer);
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
    clearInterval(this.pingTimer); clearTimeout(this.reconnectTimer); clearTimeout(this.openTimer);
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
      asks: sortedAsks, bids: sortedBids,
    };
  }
}

// ─── FILL / FEE ────────────────────────────────────────────────────────────
function simulaFill(book, quota, shares) {
  if (!book || !book.asks.length) return { fillato: false, sizeDisponibile: 0 };
  const utili = book.asks.filter(([p]) => p <= quota && p >= CFG.PREZZO_MIN_FILL);
  const sizeDisponibile = utili.reduce((s, [, size]) => s + size, 0);
  if (!utili.length) return { fillato: false, sizeDisponibile: 0 };
  const [primoPrezzo, primoSize] = utili[0];
  if (primoSize < shares) return { fillato: false, sizeDisponibile, prezzo: null };
  return { fillato: true, prezzo: primoPrezzo, size: shares, sizeDisponibile };
}
function ruoloFill(p, quota) { return Math.abs(p - quota) < 0.005 ? "MAKER" : "TAKER"; }
function feeSuFill(p, shares, feeRate) {
  if (!feeRate) return 0;
  return feeRate * p * (1 - p) * shares;
}

// ─── UN ROUND — tutte le combinazioni in parallelo ─────────────────────────
async function eseguiRound(r) {
  log(`\n${"=".repeat(70)}`);
  log(`ROUND ${r.slug} | ${r.title} | fee ${(r.feeRate * 10000).toFixed(0)} bps`);

  const reader = new BookReader([r.upToken, r.dnToken].filter(Boolean));
  reader.start();

  const inizio = roundStart();
  const tick = [];
  const stato = new Map(COMBINAZIONI.map((c) => [c.id, {
    c, fillUp: null, fillDn: null, agg: null, decisione: null, feeRound: 0,
  }]));

  while (Math.floor(Date.now() / 1000) - inizio < WINDOW) {
    const t = (Date.now() - inizio * 1000) / 1000;
    const [up, dn] = await Promise.all([reader.leggi(r.upToken), reader.leggi(r.dnToken)]);
    if (!up || !dn) { await sleep(CFG.POLL_MS); continue; }

    tick.push({ t: +t.toFixed(1), up: up.bestAsk, dn: dn.bestAsk,
                askUp: up.askSize, askDn: dn.askSize,
                bidUp: up.bestBid, bidDn: dn.bestBid });

    for (const s of stato.values()) {
      const c = s.c;

      // FILL dei due lati
      if (!s.fillUp) {
        const f = simulaFill(up, c.quota, CFG.SHARES);
        if (f.fillato) {
          s.fillUp = { prezzo: f.prezzo, t: +t.toFixed(1), ruolo: ruoloFill(f.prezzo, c.quota),
                       fee: feeSuFill(f.prezzo, CFG.SHARES, r.feeRate) };
          s.feeRound += s.fillUp.fee;
        }
      }
      if (!s.fillDn) {
        const f = simulaFill(dn, c.quota, CFG.SHARES);
        if (f.fillato) {
          s.fillDn = { prezzo: f.prezzo, t: +t.toFixed(1), ruolo: ruoloFill(f.prezzo, c.quota),
                       fee: feeSuFill(f.prezzo, CFG.SHARES, r.feeRate) };
          s.feeRound += s.fillDn.fee;
        }
      }

      // AGGIUNTA — solo se questa combinazione ha una soglia
      if (!s.decisione && !s.agg && c.sogliaAgg !== null) {
        for (const nome of ["up", "dn"]) {
          const possiedo = nome === "up" ? s.fillUp !== null : s.fillDn !== null;
          if (!possiedo) continue;
          const book = nome === "up" ? up : dn;
          const prezzo = book.bestAsk;
          if (prezzo !== null && prezzo >= c.sogliaAgg && prezzo < 0.97) {
            const f = simulaFill(book, prezzo, CFG.SHARES_AGG);
            if (f.fillato) {
              s.agg = { lato: nome, prezzo: f.prezzo, size: CFG.SHARES_AGG, t: +t.toFixed(1),
                        fee: feeSuFill(f.prezzo, CFG.SHARES_AGG, r.feeRate),
                        haToccato: false, chiuso: false, prezzoChiusura: null };
              s.feeRound += s.agg.fee;
            }
          }
        }
      }

      // TRAILING sull'aggiunta
      if (s.agg && !s.agg.chiuso) {
        const bookAgg = s.agg.lato === "up" ? up : dn;
        const pBid = bookAgg.bestBid;
        if (pBid !== null) {
          if (!s.agg.haToccato && pBid >= c.trailing) s.agg.haToccato = true;
          else if (s.agg.haToccato && pBid <= c.trailing) {
            s.agg.chiuso = true; s.agg.prezzoChiusura = pBid;
            s.feeRound += feeSuFill(pBid, s.agg.size, r.feeRate);
          }
        }
      }

      // COPPIA
      if (s.fillUp && s.fillDn && !s.decisione) {
        const speso = s.fillUp.prezzo * CFG.SHARES + s.fillDn.prezzo * CFG.SHARES;
        const netto = CFG.SHARES * 1.0 - speso - s.feeRound;
        s.decisione = { tipo: "COPPIA", a: +t.toFixed(1), costo: r2(speso), pnl: r2(netto) };
      }

      // USCITA sul lato perdente
      if (!s.decisione && !s.agg && (s.fillUp || s.fillDn)) {
        const dentroUp = s.fillUp !== null;
        const fillP = dentroUp ? s.fillUp : s.fillDn;
        if (t - fillP.t >= CFG.USCITA_MIN_S) {
          const bookC = dentroUp ? up : dn;
          const pBid = bookC.bestBid;
          if (pBid !== null && pBid <= CFG.USCITA) {
            const uscita = CFG.SHARES * pBid;
            const speso = fillP.prezzo * CFG.SHARES;
            s.feeRound += feeSuFill(pBid, CFG.SHARES, r.feeRate);
            s.decisione = { tipo: "USCITA", a: +t.toFixed(1), prezzo_uscita: r2(pBid),
                            pnl: r2(uscita - speso - s.feeRound) };
          }
        }
      }
    }

    if (Math.floor(t) % 60 === 0 && Math.abs(t - Math.round(t)) < 0.6) {
      log(`  t=${t.toFixed(0)}s | UP ask ${up.bestAsk} | DN ask ${dn.bestAsk}`);
    }
    await sleep(CFG.POLL_MS);
  }

  reader.stop();

  const upMin = Math.min(...tick.map((x) => x.up ?? 9));
  const dnMin = Math.min(...tick.map((x) => x.dn ?? 9));
  const esito = (upMin <= 0.44 && dnMin <= 0.44) ? "COPPIA" : "UN_LATO";
  const ultimo = tick[tick.length - 1] || {};

  // ── chiusura e contabilita' ──
  for (const s of stato.values()) {
    const w = wallets.get(s.c.id);

    if (!s.decisione && (s.fillUp || s.fillDn)) {
      const fillP = s.fillUp || s.fillDn;
      const latoP = s.fillUp ? "up" : "dn";
      const pU = ultimo[latoP] ?? 0.01;
      s.feeRound += feeSuFill(pU, CFG.SHARES, r.feeRate);
      s.decisione = { tipo: "FINE_ROUND", a: 300, prezzo_uscita: r2(pU),
                      pnl: r2(CFG.SHARES * pU - fillP.prezzo * CFG.SHARES - s.feeRound) };
    }
    if (!s.decisione) continue;

    let pnl = s.decisione.pnl;
    if (s.agg) {
      const finUp = ultimo.up ?? 0, finDn = ultimo.dn ?? 0;
      if (s.agg.chiuso) {
        const pnlAgg = s.agg.size * s.agg.prezzoChiusura - s.agg.size * s.agg.prezzo;
        pnl = r2(pnl + pnlAgg);
        w.aggTrail++;
      } else {
        const vince = s.agg.lato === "up" ? finUp > finDn : finDn > finUp;
        const pnlAgg = (vince ? s.agg.size * 1.0 : 0) - s.agg.size * s.agg.prezzo - s.agg.fee;
        pnl = r2(pnl + pnlAgg);
        if (vince) w.aggOk++; else w.aggKo++;
      }
    }

    w.realizzato += pnl;
    w.feeP += s.feeRound;
    w.capitale = r2(CFG.CAPITALE_INIZIALE + w.realizzato);
    w.trade.push({ slug: r.slug, tipo: s.decisione.tipo, pnl });
    if (s.decisione.tipo === "COPPIA") {
      w.coppie++; w.costoTotCoppie += s.decisione.costo; w.pnlCoppie += pnl;
    } else { w.unLato++; w.pnlUnLato += pnl; }
  }

  log(`>>> ${r.slug}`);
  log(`    esito: ${esito} | UP min: ${upMin} | DN min: ${dnMin} | ws caduti: ${reader.wsCaduto}`);
  // mostra solo le quote base (senza aggiunta) e la migliore combinazione corrente
  const base = CFG.QUOTE.map((q) => wallets.get(`${q.toFixed(2)}|noagg`));
  log(`    baseline per quota (senza aggiunta):`);
  for (const w of base) {
    log(`      ${w.quota.toFixed(2)} → coppie ${w.coppie} | PNL ${w.realizzato >= 0 ? "+" : ""}${r2(w.realizzato)} $ | saldo ${w.capitale}`);
  }
}

// ─── RIEPILOGO ─────────────────────────────────────────────────────────────
function riepilogo() {
  const righe = [...wallets.values()].map((w) => {
    const n = w.coppie + w.unLato;
    return {
      id: w.id, quota: w.quota, sogliaAgg: w.sogliaAgg, trailing: w.trailing,
      round: n, coppie: w.coppie,
      tasso: n ? +(100 * w.coppie / n).toFixed(1) : 0,
      costoC: w.coppie ? +(w.costoTotCoppie / w.coppie).toFixed(3) : null,
      profC: w.coppie ? +(w.pnlCoppie / w.coppie).toFixed(3) : null,
      aggOk: w.aggOk, aggKo: w.aggKo, aggTrail: w.aggTrail,
      PNL: r2(w.realizzato),
      perRound: n ? r3(w.realizzato / n) : 0,
      saldo: w.capitale,
    };
  }).sort((a, b) => b.PNL - a.PNL);

  log("\n════ RIEPILOGO — TOP 15 COMBINAZIONI ════");
  log(`quota | agg   | trail | coppie | tasso  | agg OK/KO/TR | PNL    | per round | saldo`);
  for (const x of righe.slice(0, 15)) {
    log(
      ` ${x.quota.toFixed(2)} | ${(x.sogliaAgg ?? "no").toString().padEnd(5)} | ${(x.trailing ?? " -").toString().padEnd(5)} | ` +
      `${String(x.coppie).padStart(6)} | ${String(x.tasso).padStart(5)}% | ` +
      `${String(x.aggOk)}/${String(x.aggKo)}/${String(x.aggTrail)}`.padEnd(12) + ` | ` +
      `${(x.PNL >= 0 ? "+" : "") + x.PNL.toFixed(2)} | ${String(x.perRound).padStart(9)} | ${x.saldo}`
    );
  }

  // miglior soglia di aggiunta (media su tutte le quote e trailing)
  const perSoglia = {};
  for (const x of righe) {
    if (x.sogliaAgg === null) continue;
    const k = x.sogliaAgg;
    perSoglia[k] = perSoglia[k] ?? { n: 0, pnl: 0, ok: 0, ko: 0, tr: 0 };
    perSoglia[k].n++; perSoglia[k].pnl += x.PNL;
    perSoglia[k].ok += x.aggOk; perSoglia[k].ko += x.aggKo; perSoglia[k].tr += x.aggTrail;
  }
  log("\n── per SOGLIA DI AGGIUNTA (media su tutte le quote/trailing) ──");
  const soglie = Object.entries(perSoglia).map(([s, v]) => ({
    soglia: +s, pnlMedio: +(v.pnl / v.n).toFixed(3), ok: v.ok, ko: v.ko, tr: v.tr,
    winRate: (v.ok + v.ko + v.tr) ? +(100 * (v.ok + v.tr) / (v.ok + v.ko + v.tr)).toFixed(1) : 0,
  })).sort((a, b) => b.pnlMedio - a.pnlMedio);
  for (const x of soglie) {
    log(`  agg >= ${x.soglia.toFixed(2)} → PNL medio ${x.pnlMedio >= 0 ? "+" : ""}${x.pnlMedio} $ | OK ${x.ok} · KO ${x.ko} · TRAIL ${x.tr} | win ${x.winRate}%`);
  }

  // miglior trailing (media)
  const perTrail = {};
  for (const x of righe) {
    if (x.trailing === null) continue;
    const k = x.trailing;
    perTrail[k] = perTrail[k] ?? { n: 0, pnl: 0 };
    perTrail[k].n++; perTrail[k].pnl += x.PNL;
  }
  log("\n── per TRAILING (media su tutte le quote/soglie) ──");
  Object.entries(perTrail).map(([s, v]) => ({ t: +s, pnlMedio: +(v.pnl / v.n).toFixed(3) }))
    .sort((a, b) => b.pnlMedio - a.pnlMedio)
    .forEach((x) => log(`  trailing ${x.t.toFixed(2)} → PNL medio ${x.pnlMedio >= 0 ? "+" : ""}${x.pnlMedio} $`));

  log(`\nMIGLIORE: ${righe[0].id} con PNL ${righe[0].PNL >= 0 ? "+" : ""}${righe[0].PNL} $ su ${righe[0].round} round`);
  log("══════════════════════════════════════════");
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  log("═══════════════════════════════════════════════════════");
  log("  xpaper — PAPER v7 · MULTI-QUOTA + MULTI-SOGLIA");
  log("═══════════════════════════════════════════════════════");
  log(`  quote: ${CFG.QUOTE.map((q) => q.toFixed(2)).join(" · ")}`);
  log(`  soglie aggiunta: ${CFG.SOGLIE_AGG.map((s) => s.toFixed(2)).join(" · ")}`);
  log(`  trailing: ${CFG.TRAILINGS.map((s) => s.toFixed(2)).join(" · ")}`);
  log(`  combinazioni totali: ${COMBINAZIONI.length}`);
  log(`  uscita lato perdente: ${CFG.USCITA} dopo ${CFG.USCITA_MIN_S}s`);
  log("═══════════════════════════════════════════════════");

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
