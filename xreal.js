// ═══════════════════════════════════════════════════════════════════════════
// xreal.js — v2.0 · PAPER con PORTAFOGLIO DEMO (nessun soldo vero)
//
// CORREZIONE v2.0 (bug "coppie mai prese"):
//   La v1.0 comprava i due lati SOLO se `posizioni.length === 0`, e dopo il
//   primo fill non ci tornava piu' sopra. Risultato: il bot comprava UN lato
//   e ignorava il secondo per tutto il round. Nei 10 round demo: 7 su 10
//   avevano entrambi i lati disponibili a 0.44, e il bot non ne ha presa
//   nessuna -> il PnL negativo era falsato dalla copertura mancante.
//   ORA: ogni lato si compra quando il SUO prezzo scende a 0.44, in
//   qualunque momento del round, indipendentemente dall'altro.
//
// DATI: reali (WebSocket Polymarket). PORTAFOGLIO: demo. ORDINI: simulati.
// ═══════════════════════════════════════════════════════════════════════════

import WebSocket from "ws";
import fs from "fs";
import path from "path";

const CFG = {
  CAPITALE: 50,            // portafoglio DEMO di partenza
  SHARES: 5,               // share per lato all'apertura
  SHARES_AGG: 5,           // share per l'aggiunta
  QUOTA: 0.46,             // entrata: ogni lato entra quando bestAsk <= 0.46
                           //   (0.46 = più coppie della 0.44 e costo medio
                           //    più basso: 38/57 coppie a 4.89 $ contro 35 a 4.97)
  SOGLIA_AGG: 0.50,        // aggiunta: parte quando bestAsk >= 0.50
  AGG_DOPO_S: 90,          // ← l'aggiunta parte solo DOPO 90s dal primo fill,
                           //    e solo se sono ancora scoperto (un lato solo).
                           //    Così si dà tempo al secondo lato di formare la coppia.
  TRAILING: 0.90,          // esce se il bid tocca 0.90 e poi riscende
  USCITA: 0.40,            // taglia il lato perdente (solo se e' solo)
  USCITA_MIN_S: 60,        // non uscire prima di 60s dal fill
  PREZZO_MIN_FILL: 0.25,
  MAX_ROUNDS: 10,          // round e poi esce (per l'upload)
  POLL_MS: 1000,
  FILTRO_ON: true,         // se il round parte sbilanciato NON entra
  FILTRO_SOMMA_MIN: 0.70,  // somma dei due ask sotto questa soglia = round deciso
  FILTRO_DOPO_S: 3,
  OUT_DIR: "out-real",
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
const roundStart = (now = Date.now()) => Math.floor(now / 1000 / WINDOW) * WINDOW;

// ─── PORTAFOGLIO DEMO ──────────────────────────────────────────────────────
const PF = {
  contante: CFG.CAPITALE,
  investito: 0,
  incassato: 0,
  speso: 0,
  feeTotali: 0,
  roundGiocati: 0,
  roundVinti: 0,
  roundPersi: 0,
  roundSaltati: 0,
  storico: [],
};

function apriPosizione(lato, prezzo, shares, slug, t, ordini, tipo) {
  const costo = r4(prezzo * shares);
  if (costo > PF.contante) {
    ordini.push({ slug, t, lato, tipo: "RIFIUTATO", prezzo, shares, costo, motivo: "contante insufficiente" });
    log(`    ✋ ${tipo} ${lato} RIFIUTATO: serve ${costo} $ ma contante ${r2(PF.contante)} $`);
    return null;
  }
  PF.contante = r4(PF.contante - costo);
  PF.investito = r4(PF.investito + costo);
  PF.speso = r4(PF.speso + costo);
  ordini.push({ slug, t, lato, tipo, prezzo, shares, costo });
  log(`    → ${tipo} ${lato} ${shares}@${prezzo} = ${costo} $ | contante ${r2(PF.contante)} $`);
  return { lato, prezzo, shares, t, costo };
}

function feeSuFill(p, shares, feeRate) {
  if (!feeRate) return 0;
  return feeRate * p * (1 - p) * shares;
}

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
    return { slug, title: ev[0].title, upToken: tokens?.[0] ?? null, dnToken: tokens?.[1] ?? null,
             feeRate: feeBps / 10000 };
  } catch (e) { log("[warn] gamma:", e.message); return null; }
}

// ─── BOOK READER (WebSocket) ───────────────────────────────────────────────
class BookReader {
  constructor(tokens) {
    this.tokens = tokens; this.books = new Map(); this.ws = null;
    this.pingTimer = null; this.reconnectTimer = null; this.openTimer = null;
    this.chiuso = false; this.wsCaduto = 0;
  }
  start() {
    if (this.chiuso) return;
    if (this.ws) { try { this.ws.removeAllListeners(); this.ws.terminate(); } catch (_) {} this.ws = null; }
    clearInterval(this.pingTimer); clearTimeout(this.reconnectTimer); clearTimeout(this.openTimer);
    try { this.ws = new WebSocket(CFG.WS_URL); } catch (e) { log("[ws] err:", e.message); this._riprova(); return; }
    this.openTimer = setTimeout(() => { if (this.ws && this.ws.readyState !== 1) this._riprova(); }, CFG.WS_OPEN_TIMEOUT_MS);
    this.ws.on("open", () => {
      clearTimeout(this.openTimer);
      try { this.ws.send(JSON.stringify({ type: "subscribe", channel: "book", assets_ids: this.tokens })); } catch (_) {}
      log("[ws] connesso");
      this.pingTimer = setInterval(() => { try { if (this.ws && this.ws.readyState === 1) this.ws.ping(); } catch (_) {} }, CFG.WS_PING_MS);
    });
    this.ws.on("pong", () => {});
    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        for (const m of (Array.isArray(msg) ? msg : [msg])) {
          if (m.type === "book" || m.event_type === "book") {
            const id = m.asset_id || m.market; if (!id) continue;
            this.books.set(id, {
              bids: (m.bids || m.buys || []).map((b) => [parseFloat(b.price), parseFloat(b.size)]),
              asks: (m.asks || m.sells || []).map((a) => [parseFloat(a.price), parseFloat(a.size)]),
            });
          }
        }
      } catch (_) {}
    });
    this.ws.on("close", () => {
      clearInterval(this.pingTimer); clearTimeout(this.openTimer); this.wsCaduto++;
      if (this.chiuso) return;
      log(`[ws] chiuso (#${this.wsCaduto}), riconnessione`);
      this._riprova();
    });
    this.ws.on("error", () => {});
  }
  _riprova() { if (this.chiuso) return; clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.start(), CFG.WS_RECONNECT_MS); }
  stop() { this.chiuso = true; clearInterval(this.pingTimer); clearTimeout(this.reconnectTimer);
    clearTimeout(this.openTimer); try { this.ws?.removeAllListeners(); this.ws?.terminate(); } catch (_) {} }

  async leggi(tokenId) {
    if (!tokenId) return null;
    let b = this.books.get(tokenId);
    if (!b || (!b.bids.length && !b.asks.length)) {
      try {
        const r = await jget(`${CLOB}/book?token_id=${tokenId}`);
        b = { bids: (r.bids || []).map((x) => [parseFloat(x.price), parseFloat(x.size)]),
              asks: (r.asks || []).map((x) => [parseFloat(x.price), parseFloat(x.size)]) };
        this.books.set(tokenId, b);
      } catch (_) { return null; }
    }
    const bids = (b.bids || []).filter((x) => isFinite(x[0]) && isFinite(x[1]) && x[1] > 0);
    const asks = (b.asks || []).filter((x) => isFinite(x[0]) && isFinite(x[1]) && x[1] > 0);
    const sA = [...asks].sort((a, c) => a[0] - c[0]);
    const sB = [...bids].sort((a, c) => c[0] - a[0]);
    return { bestBid: sB.length ? sB[0][0] : null, bestAsk: sA.length ? sA[0][0] : null,
             askSize: sA.length ? sA[0][1] : 0, asks: sA, bids: sB };
  }
}

function simulaFill(book, quota, shares) {
  if (!book || !book.asks.length) return { fillato: false };
  const utili = book.asks.filter(([p]) => p <= quota && p >= CFG.PREZZO_MIN_FILL);
  if (!utili.length) return { fillato: false };
  const [primoPrezzo, primoSize] = utili[0];
  if (primoSize < shares) return { fillato: false };
  return { fillato: true, prezzo: primoPrezzo, size: shares };
}

// ─── SALVATAGGI ────────────────────────────────────────────────────────────
function salvaTick(slug, tick) {
  try {
    fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CFG.OUT_DIR, `${slug}.csv`),
      "t,up_ask,up_size,dn_ask,dn_size,up_bid,dn_bid\n" +
      tick.map((x) => [x.t, x.up ?? "", Math.round(x.up ? x.askUp : 0),
                       x.dn ?? "", Math.round(x.dn ? x.askDn : 0),
                       x.bidUp ?? "", x.bidDn ?? ""].join(",")).join("\n"));
  } catch (e) { log("[err] salvaTick:", e.message); }
}
function salvaOrdini(slug, ordini) {
  try {
    fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
    const f = path.join(CFG.OUT_DIR, "ordini.csv");
    if (!fs.existsSync(f)) fs.writeFileSync(f, "slug,t,lato,tipo,prezzo,shares,costo,nota\n");
    fs.appendFileSync(f, ordini.map((o) =>
      [slug, o.t ?? "", o.lato, o.tipo, o.prezzo ?? "", o.shares ?? "", o.costo ?? "", o.motivo ?? (o.incasso ?? "")].join(",")
    ).join("\n") + "\n");
  } catch (e) { log("[err] salvaOrdini:", e.message); }
}
function salvaPortfolio(slug, riga) {
  try {
    fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
    const f = path.join(CFG.OUT_DIR, "portfolio.csv");
    if (!fs.existsSync(f)) fs.writeFileSync(f,
      "slug,saldo_prima,saldo_dopo,pnl_round,investito_round,esito,coppia,aggiunta,trailing,uscita,saltato,note\n");
    fs.appendFileSync(f, riga.join(",") + "\n");
  } catch (e) { log("[err] salvaPortfolio:", e.message); }
}
function salvaCoppie(slug, riga) {
  try {
    fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
    const f = path.join(CFG.OUT_DIR, "coppie.csv");
    if (!fs.existsSync(f)) fs.writeFileSync(f,
      "slug,up_min,dn_min,t_up_fill,t_dn_fill,coppia_presa,somma_ask_inizio,esito,motivo\n");
    fs.appendFileSync(f, riga.join(",") + "\n");
  } catch (e) { log("[err] salvaCoppie:", e.message); }
}

// ─── UN ROUND ──────────────────────────────────────────────────────────────
async function eseguiRound(r) {
  log(`\n${"=".repeat(70)}`);
  log(`ROUND ${r.slug} | ${r.title} | fee ${(r.feeRate * 10000).toFixed(0)} bps`);
  log(`    contante demo: ${r2(PF.contante)} $ | investito ${r2(PF.investito)} $`);

  const saldoPrima = PF.contante;
  const reader = new BookReader([r.upToken, r.dnToken].filter(Boolean));
  reader.start();

  const inizio = roundStart();
  const tick = [];
  const ordini = [];
  const posizioni = [];
  let agg = null;
  let decisione = null;
  let filtroPassato = !CFG.FILTRO_ON ? true : null;
  let sommaInizio = null;
  let tFillUp = null, tFillDn = null;
  let minUp = 9, minDn = 9;
  let aggAvvisato = false;

  while (Math.floor(Date.now() / 1000) - inizio < WINDOW) {
    const t = (Date.now() - inizio * 1000) / 1000;
    const [up, dn] = await Promise.all([reader.leggi(r.upToken), reader.leggi(r.dnToken)]);
    if (!up || !dn) { await sleep(CFG.POLL_MS); continue; }

    tick.push({ t: +t.toFixed(1), up: up.bestAsk, dn: dn.bestAsk,
                askUp: up.askSize, askDn: dn.askSize, bidUp: up.bestBid, bidDn: dn.bestBid });

    if (up.bestAsk) minUp = Math.min(minUp, up.bestAsk);
    if (dn.bestAsk) minDn = Math.min(minDn, dn.bestAsk);

    // ── FILTRO PRESUPPOSTI
    if (filtroPassato === null && t >= CFG.FILTRO_DOPO_S && up.bestAsk && dn.bestAsk) {
      sommaInizio = r4(up.bestAsk + dn.bestAsk);
      filtroPassato = sommaInizio >= CFG.FILTRO_SOMMA_MIN;
      log(filtroPassato
        ? `    ✓ filtro: somma ask ${sommaInizio} >= ${CFG.FILTRO_SOMMA_MIN} → si entra`
        : `    ✋ FILTRO: somma ask ${sommaInizio} < ${CFG.FILTRO_SOMMA_MIN} → round saltato`);
    }
    if (filtroPassato === false) {
      if (Math.floor(Date.now() / 1000) - inizio >= WINDOW - 1) break;
      await sleep(CFG.POLL_MS);
      continue;
    }

    // ── APERTURA v2.0: ogni lato entra quando il SUO prezzo tocca 0.44,
    //    in qualunque momento del round, indipendentemente dall'altro.
    if (!posizioni.find((p) => p.lato === "up")) {
      const fUp = simulaFill(up, CFG.QUOTA, CFG.SHARES);
      if (fUp.fillato) {
        const p = apriPosizione("up", fUp.prezzo, CFG.SHARES, r.slug, +t.toFixed(1), ordini, "APERTURA");
        if (p) { posizioni.push(p); tFillUp = +t.toFixed(1); }
      }
    }
    if (!posizioni.find((p) => p.lato === "dn")) {
      const fDn = simulaFill(dn, CFG.QUOTA, CFG.SHARES);
      if (fDn.fillato) {
        const p = apriPosizione("dn", fDn.prezzo, CFG.SHARES, r.slug, +t.toFixed(1), ordini, "APERTURA");
        if (p) { posizioni.push(p); tFillDn = +t.toFixed(1); }
      }
    }

    // ── AGGIUNTA: SOLO se ho un lato solo (scoperto).
    //    Se la coppia e' completa NON si compra piu' nulla: la coppia e' gia'
    //    matematica (uno dei due lati paga 1.00) e aggiungere raddoppia il
    //    rischio senza aumentare la copertura. Si aspetta la scadenza.
    if (posizioni.length >= 2 && !agg && !aggAvvisato) {
      aggAvvisato = true;
      log(`    ⊘ coppia completa → nessuna aggiunta, si aspetta la scadenza`);
    }
    //    Inoltre parte solo DOPO AGG_DOPO_S secondi dal primo fill: cosi' si da
    //    tempo al secondo lato di formare la coppia prima di aggiungere.
    if (!agg && posizioni.length === 1) {
      const p0 = posizioni[0];
      if ((t - p0.t) < CFG.AGG_DOPO_S) {
        // ancora dentro la finestra di attesa: non aggiungere
      } else
      for (const p of posizioni) {
        const book = p.lato === "up" ? up : dn;
        const ask = book.bestAsk;
        if (ask !== null && ask >= CFG.SOGLIA_AGG && ask < 0.97) {
          const prezzoFill = Math.min(ask, CFG.SOGLIA_AGG);
          if (book.askSize >= CFG.SHARES_AGG && prezzoFill * CFG.SHARES_AGG <= PF.contante) {
            const np = apriPosizione(p.lato, prezzoFill, CFG.SHARES_AGG, r.slug, +t.toFixed(1), ordini, "AGGIUNTA");
            if (np) agg = { ...np, haToccato: false, chiuso: false, prezzoChiusura: null };
          }
          break;
        }
      }
    }

    // ── TRAILING sull'aggiunta: esce solo se tocca 0.90 e poi riscende
    if (agg && !agg.chiuso) {
      const bookAgg = agg.lato === "up" ? up : dn;
      const bid = bookAgg.bestBid;
      if (bid !== null) {
        if (!agg.haToccato && bid >= CFG.TRAILING) {
          agg.haToccato = true;
          log(`    ↑ ${agg.lato} tocca ${CFG.TRAILING} (bid ${bid})`);
        } else if (agg.haToccato && bid <= CFG.TRAILING) {
          agg.chiuso = true; agg.prezzoChiusura = bid;
          const incasso = r4(bid * agg.shares);
          PF.contante = r4(PF.contante + incasso);
          PF.incassato = r4(PF.incassato + incasso);
          PF.investito = r4(PF.investito - agg.costo);
          const fee = feeSuFill(bid, agg.shares, r.feeRate);
          PF.feeTotali = r4(PF.feeTotali + fee);
          ordini.push({ slug: r.slug, t: +t.toFixed(1), lato: agg.lato, tipo: "TRAILING", prezzo: bid,
                        shares: agg.shares, costo: r4(incasso - agg.costo), nota: `pnl ${r2(incasso - agg.costo)}` });
          log(`    ← TRAILING ${agg.lato} a ${bid} = ${r2(incasso)} $`);
        }
      }
    }

    // ── USCITA sul lato perdente: SOLO se ho un lato solo (senza copertura)
    if (!decisione && !agg && posizioni.length === 1) {
      const p = posizioni[0];
      const book = p.lato === "up" ? up : dn;
      const bid = book.bestBid;
      if (bid !== null && t - p.t >= CFG.USCITA_MIN_S && bid <= CFG.USCITA) {
        const incasso = r4(bid * p.shares);
        PF.contante = r4(PF.contante + incasso);
        PF.incassato = r4(PF.incassato + incasso);
        PF.investito = r4(PF.investito - p.costo);
        ordini.push({ slug: r.slug, t: +t.toFixed(1), lato: p.lato, tipo: "USCITA", prezzo: bid,
                      shares: p.shares, costo: r4(incasso - p.costo), nota: `pnl ${r2(incasso - p.costo)}` });
        decisione = "USCITA";
        posizioni.length = 0;   // lato chiuso: non rientra nella scadenza
        log(`    ← USCITA ${p.lato} a ${bid} = ${r2(incasso)} $`);
      }
    }

    if (!decisione && posizioni.length >= 2) decisione = "COPPIA";

    await sleep(CFG.POLL_MS);
  }
  reader.stop();
  salvaTick(r.slug, tick);

  // ── chiusura a scadenza
  const ultimo = tick[tick.length - 1] || {};
  const finUp = ultimo.up ?? 0, finDn = ultimo.dn ?? 0;
  let incasso = 0;
  const rimaste = [];
  for (const p of posizioni) {
    const vince = p.lato === "up" ? finUp > finDn : finDn > finUp;
    const valore = vince ? p.shares * 1.0 : 0;
    const fee = feeSuFill(p.prezzo, p.shares, r.feeRate);
    incasso += valore - fee;
    PF.feeTotali = r4(PF.feeTotali + fee);
    PF.investito = r4(PF.investito - p.costo);
    rimaste.push({ lato: p.lato, shares: p.shares, vince, valore: r4(valore) });
  }
  incasso = r4(incasso);
  PF.contante = r4(PF.contante + incasso);
  PF.incassato = r4(PF.incassato + incasso);
  ordini.push({ slug: r.slug, t: 300, lato: "-", tipo: "SCADENZA", prezzo: `up ${finUp} dn ${finDn}`,
                shares: posizioni.reduce((s, p) => s + p.shares, 0), costo: incasso,
                nota: rimaste.map((x) => `${x.lato}${x.vince ? "V" : "P"}`).join(" ") });

  const pnlRound = r4(PF.contante - saldoPrima);
  const saltato = filtroPassato === false;
  if (saltato) PF.roundSaltati++;
  else {
    if (pnlRound >= 0) PF.roundVinti++; else PF.roundPersi++;
    PF.roundGiocati++;
  }
  PF.storico.push({ slug: r.slug, pnl: pnlRound, saltato });

  // ── registri
  salvaOrdini(r.slug, ordini);
  salvaPortfolio(r.slug, [r.slug, r2(saldoPrima), r2(PF.contante), pnlRound,
    posizioni.reduce((s, p) => s + p.costo, 0), decisione ?? (saltato ? "SALTATO" : "FINE"),
    posizioni.length >= 2 ? "si" : "no", agg ? "si" : "no",
    agg?.chiuso ? "si" : "no", decisione === "USCITA" ? "si" : "no",
    saltato ? "si" : "no", `up ${finUp} dn ${finDn}`]);
  salvaCoppie(r.slug, [r.slug, minUp === 9 ? "" : minUp.toFixed(3), minDn === 9 ? "" : minDn.toFixed(3),
    tFillUp ?? "", tFillDn ?? "", (tFillUp !== null && tFillDn !== null) ? "SI" : "NO",
    sommaInizio ?? "", decisione ?? (saltato ? "SALTATO" : "FINE"),
    saltato ? "filtro" : (tFillUp !== null && tFillDn !== null ? "coppia piena" : "un solo lato")]);

  log(`>>> ${r.slug} | ${decisione ?? (saltato ? "SALTATO" : "FINE")} | PNL round ${pnlRound >= 0 ? "+" : ""}${pnlRound} $ | contante ${r2(PF.contante)} $`);
  return pnlRound;
}

// ─── RIEPILOGO ─────────────────────────────────────────────────────────────
function riepilogo() {
  const saldoFinale = r2(PF.contante + PF.investito);
  log(`\n═══════════ RIEPILOGO PORTAFOGLIO (demo) ═══════════`);
  log(`  capitale iniziale:  ${CFG.CAPITALE} $`);
  log(`  contante attuale:   ${r2(PF.contante)} $`);
  log(`  investito:          ${r2(PF.investito)} $`);
  log(`  fee pagate:         ${r2(PF.feeTotali)} $`);
  log(`  round giocati:      ${PF.roundGiocati}  (vinti ${PF.roundVinti} · persi ${PF.roundPersi})`);
  log(`  round saltati:      ${PF.roundSaltati}`);
  log(`  ─────────────────────────────────────────`);
  log(`  SALDO FINALE DEMO:  ${saldoFinale} $   (${saldoFinale - CFG.CAPITALE >= 0 ? "+" : ""}${r2(saldoFinale - CFG.CAPITALE)} $)`);
  log(`════════════════════════════════════════════════════`);
  try {
    fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CFG.OUT_DIR, "riepilogo.txt"),
      `capitale ${CFG.CAPITALE}\ncontante ${r2(PF.contante)}\ninvestito ${r2(PF.investito)}\n` +
      `saldo_finale ${saldoFinale}\npnl ${r2(saldoFinale - CFG.CAPITALE)}\n` +
      `round ${PF.roundGiocati}\nvinti ${PF.roundVinti}\npersi ${PF.roundPersi}\n` +
      `saltati ${PF.roundSaltati}\nfee ${r2(PF.feeTotali)}\n`);
  } catch (_) {}
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  log("═══════════════════════════════════════════════");
  log("  xreal v2.0 · PAPER con PORTAFOGLIO DEMO");
  log("  coppie: ogni lato entra quando tocca la quota");
  log("═══════════════════════════════════════════════");
  log(`  capitale demo: ${CFG.CAPITALE} $ · ${CFG.SHARES} share/lato · MAX_ROUNDS ${CFG.MAX_ROUNDS}`);
  log(`  entrata ${CFG.QUOTA} · aggiunta ${CFG.SOGLIA_AGG} (tetto) · trailing ${CFG.TRAILING} · uscita ${CFG.USCITA}`);
  log("═══════════════════════════════════════════════");

  let fatti = 0, tentativi = 0;
  while (fatti < CFG.MAX_ROUNDS && tentativi < CFG.MAX_ROUNDS * 4) {
    tentativi++;
    const start = roundStart();
    const r = await trovaRound(start);
    if (!r || !r.upToken || !r.dnToken) { log(`[wait] round ${start} non trovato`); await sleep(15000); continue; }
    const prima = PF.roundGiocati + PF.roundSaltati;
    try { await eseguiRound(r); } catch (e) { log("[err]", e.message); }
    if (PF.roundGiocati + PF.roundSaltati > prima) fatti++;
    await sleep(Math.max(1000, (start + WINDOW) * 1000 - Date.now() + 2000));
  }

  riepilogo();
  log(`\n[exit] ${fatti} round — il job termina, l'upload parte`);
  process.exit(0);
}

process.on("SIGINT", () => { riepilogo(); process.exit(0); });
process.on("SIGTERM", () => { riepilogo(); process.exit(0); });
main().catch((e) => { console.error(e); process.exit(1); });
