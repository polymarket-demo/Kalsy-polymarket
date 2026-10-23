// ═══════════════════════════════════════════════════════════════════════════
// xreal.js — v1.0 · PAPER CON PORTAFOGLIO DEMO (nessun soldo vero)
//
// Differenza da xpaper: qui il portafoglio parte da 50 $ DEMO e si muove.
// Ogni acquisto scala il contante subito. Se il contante finisce, non compra.
// Nessuna stima: ogni round chiude e aggiorna il saldo con quello che incassa.
//
// DATI: reali (WebSocket Polymarket). PORTAFOGLIO: demo. ORDINI: simulati.
// Conta ask, tick, size e fee come xpaper v7.3.
// ═══════════════════════════════════════════════════════════════════════════

import WebSocket from "ws";
import fs from "fs";
import path from "path";

const CFG = {
  CAPITALE: 50,            // portafoglio DEMO di partenza
  SHARES: 5,               // share per lato all'apertura
  SHARES_AGG: 5,           // share per l'aggiunta
  QUOTA: 0.44,             // entrata: compra quando bestAsk <= 0.44
  SOGLIA_AGG: 0.50,        // aggiunta: parte quando bestAsk >= 0.50
  TRAILING: 0.90,          // esce quando il bid tocca 0.90 e poi riscende
  USCITA: 0.40,            // taglia il lato perdente
  USCITA_MIN_S: 60,        // non uscire prima di 60s dal fill
  PREZZO_MIN_FILL: 0.25,
  MAX_ROUNDS: 10,           // ← 10 round e poi esce (per l'upload)
  POLL_MS: 1000,
  FILTRO_ON: true,         // ← se il round parte sbilanciato NON entra
  FILTRO_SOMMA_MIN: 0.70,  // somma dei due ask sotto questa soglia = round gia' deciso
  FILTRO_DOPO_S: 3,        // il controllo si fa ai primi secondi del round
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
  storico: [],
};

function apriPosizione(lato, prezzo, shares, slug, t, ordini, tipo) {
  const costo = r4(prezzo * shares);
  if (costo > PF.contante) {
    ordini.push({ slug, t, lato, tipo: "RIFIUTATO", prezzo, shares, costo, motivo: "contante insufficiente" });
    log(`    ✋ ordine ${tipo} ${lato} RIFIUTATO: serve ${costo} $ ma contante ${r2(PF.contante)} $`);
    return null;
  }
  PF.contante = r4(PF.contante - costo);
  PF.investito = r4(PF.investito + costo);
  PF.speso = r4(PF.speso + costo);
  ordini.push({ slug, t, lato, tipo, prezzo, shares, costo });
  log(`    → ${tipo} ${lato} ${shares}@${prezzo} = ${costo} $ | contante ${r2(PF.contante)} $`);
  return { lato, prezzo, shares, t, costo };
}

// ─── FEE ───────────────────────────────────────────────────────────────────
function feeSuFill(p, shares, feeRate) {
  if (!feeRate) return 0;
  return feeRate * p * (1 - p) * shares;
}

// ─── ROUND ─────────────────────────────────────────────────────────────────
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

// ─── BOOK READER (WebSocket, come xpaper v7.3) ─────────────────────────────
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

// ─── FILL: compra al bestAsk se <= quota e size sufficiente ────────────────
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
  const posizioni = [];        // posizioni aperte di questo round
  let agg = null;
  let decisione = null;
  let filtroPassato = !CFG.FILTRO_ON ? true : null;   // null = non ancora deciso
  let sommaFiltro = null;

  while (Math.floor(Date.now() / 1000) - inizio < WINDOW) {
    const t = (Date.now() - inizio * 1000) / 1000;
    const [up, dn] = await Promise.all([reader.leggi(r.upToken), reader.leggi(r.dnToken)]);
    if (!up || !dn) { await sleep(CFG.POLL_MS); continue; }

    tick.push({ t: +t.toFixed(1), up: up.bestAsk, dn: dn.bestAsk,
                askUp: up.askSize, askDn: dn.askSize, bidUp: up.bestBid, bidDn: dn.bestBid });

    // ── FILTRO PRESUPPOSTI: se il round e' gia' deciso, NON si entra
    if (filtroPassato === null && t >= CFG.FILTRO_DOPO_S && up.bestAsk && dn.bestAsk) {
      sommaFiltro = r4(up.bestAsk + dn.bestAsk);
      filtroPassato = sommaFiltro >= CFG.FILTRO_SOMMA_MIN;
      if (!filtroPassato) {
        log(`    ✋ FILTRO: somma ask ${sommaFiltro} < ${CFG.FILTRO_SOMMA_MIN} → round saltato, non si entra`);
      } else {
        log(`    ✓ filtro: somma ask ${sommaFiltro} >= ${CFG.FILTRO_SOMMA_MIN} → si entra`);
      }
    }
    if (filtroPassato === false) {
      // continua a leggere e salvare i tick, ma non opera
      if (Math.floor(Date.now() / 1000) - inizio >= WINDOW - 1) break;
      await sleep(CFG.POLL_MS);
      continue;
    }

    // ── apertura: entrambi i lati a 0.44
    if (!posizioni.length) {
      const fUp = simulaFill(up, CFG.QUOTA, CFG.SHARES);
      const fDn = simulaFill(dn, CFG.QUOTA, CFG.SHARES);
      if (fUp.fillato) { const p = apriPosizione("up", fUp.prezzo, CFG.SHARES, r.slug, +t.toFixed(1), ordini, "APERTURA"); if (p) posizioni.push(p); }
      if (fDn.fillato) { const p = apriPosizione("dn", fDn.prezzo, CFG.SHARES, r.slug, +t.toFixed(1), ordini, "APERTURA"); if (p) posizioni.push(p); }
    }

    // ── aggiunta: sul lato posseduto che sale oltre 0.50, MAI sopra la soglia
    if (!agg && posizioni.length) {
      const latiPosseduti = posizioni.map((p) => p.lato);
      for (const lato of latiPosseduti) {
        const book = lato === "up" ? up : dn;
        const ask = book.bestAsk;
        if (ask !== null && ask >= CFG.SOGLIA_AGG && ask < 0.97) {
          const prezzoFill = Math.min(ask, CFG.SOGLIA_AGG);   // ← tetto: mai sopra
          if (book.askSize >= CFG.SHARES_AGG && prezzoFill * CFG.SHARES_AGG <= PF.contante) {
            const p = apriPosizione(lato, prezzoFill, CFG.SHARES_AGG, r.slug, +t.toFixed(1), ordini, "AGGIUNTA");
            if (p) { agg = { ...p, haToccato: false, chiuso: false, prezzoChiusura: null }; }
          }
          break;
        }
      }
    }

    // ── trailing sull'aggiunta
    // Esce SOLO se il bid tocca 0.90 e poi riscende sotto 0.90.
    // Se non tocca mai 0.90, NON esce: resta fino alla fine del round.
    if (agg && !agg.chiuso) {
      const bookAgg = agg.lato === "up" ? up : dn;
      const bid = bookAgg.bestBid;
      if (bid !== null) {
        if (!agg.haToccato && bid >= CFG.TRAILING) {
          agg.haToccato = true;
          log(`    ↑ ${agg.lato} ha toccato ${CFG.TRAILING} (bid ${bid}) → da ora esce se riscende`);
        }
        else if (agg.haToccato && bid <= CFG.TRAILING) {
          agg.chiuso = true; agg.prezzoChiusura = bid;
          const incasso = r4(bid * agg.shares);
          PF.contante = r4(PF.contante + incasso);
          PF.incassato = r4(PF.incassato + incasso);
          PF.investito = r4(PF.investito - agg.costo);
          const fee = feeSuFill(bid, agg.shares, r.feeRate);
          PF.feeTotali = r4(PF.feeTotali + fee);
          ordini.push({ slug: r.slug, t: +t.toFixed(1), lato: agg.lato, tipo: "TRAILING", prezzo: bid, shares: agg.shares,
                        costo: r4(incasso - agg.costo), nota: `pnl ${r2(incasso - agg.costo)}` });
          log(`    ← TRAILING ${agg.lato} a ${bid} = ${r2(incasso)} $ | contante ${r2(PF.contante)} $`);
        }
      }
    }

    // ── uscita sul lato perdente (solo se ho un lato solo e nessuna aggiunta)
    if (!decisione && !agg && posizioni.length === 1) {
      const p = posizioni[0];
      const book = p.lato === "up" ? up : dn;
      const bid = book.bestBid;
      if (bid !== null && t - p.t >= CFG.USCITA_MIN_S && bid <= CFG.USCITA) {
        const incasso = r4(bid * p.shares);
        PF.contante = r4(PF.contante + incasso);
        PF.incassato = r4(PF.incassato + incasso);
        PF.investito = r4(PF.investito - p.costo);
        ordini.push({ slug: r.slug, t: +t.toFixed(1), lato: p.lato, tipo: "USCITA", prezzo: bid, shares: p.shares,
                      costo: r4(incasso - p.costo), nota: `pnl ${r2(incasso - p.costo)}` });
        decisione = "USCITA";
        log(`    ← USCITA ${p.lato} a ${bid} = ${r2(incasso)} $ | contante ${r2(PF.contante)} $`);
      }
    }

    // ── se ho entrambi i lati, la coppia e' chiusa: non serve altro
    if (!decisione && posizioni.length === 2) decisione = "COPPIA";

    await sleep(CFG.POLL_MS);
  }
  reader.stop();
  salvaTick(r.slug, tick);

  // ── chiusura a scadenza: quello che resta in mano paga o non paga
  const ultimo = tick[tick.length - 1] || {};
  const finUp = ultimo.up ?? 0, finDn = ultimo.dn ?? 0;
  let incasso = 0;
  const rimaste = [];
  for (const p of posizioni) {
    if (p.lato === "up" && decisione === "USCITA") continue;
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
  if (pnlRound >= 0) PF.roundVinti++; else PF.roundPersi++;
  PF.roundGiocati++;
  PF.storico.push({ slug: r.slug, pnl: pnlRound });

  salvaOrdini(r.slug, ordini);
  salvaPortfolio(r.slug, [r.slug, r2(saldoPrima), r2(PF.contante), pnlRound,
    posizioni.reduce((s, p) => s + p.costo, 0), decisione ?? "FINE",
    posizioni.length === 2 ? "si" : "no", agg ? "si" : "no",
    agg?.chiuso ? "si" : "no", decisione === "USCITA" ? "si" : "no", "no",
    `up ${finUp} dn ${finDn}`]);

  log(`>>> ${r.slug} | ${decisione ?? "FINE"} | PNL round ${pnlRound >= 0 ? "+" : ""}${pnlRound} $ | contante ${r2(PF.contante)} $`);
  return pnlRound;
}

// ─── RIEPILOGO ─────────────────────────────────────────────────────────────
function riepilogo() {
  log(`\n═══════════ RIEPILOGO PORTAFOGLIO (demo) ═══════════`);
  log(`  capitale iniziale:  ${CFG.CAPITALE} $`);
  log(`  contante attuale:   ${r2(PF.contante)} $`);
  log(`  investito:          ${r2(PF.investito)} $`);
  log(`  totale incassato:   ${r2(PF.incassato)} $`);
  log(`  totale speso:       ${r2(PF.speso)} $`);
  log(`  fee pagate:         ${r2(PF.feeTotali)} $`);
  log(`  round giocati:      ${PF.roundGiocati}  (vinti ${PF.roundVinti} · persi ${PF.roundPersi})`);
  const saldoFinale = r2(PF.contante + PF.investito);
  log(`  ─────────────────────────────────────────`);
  log(`  SALDO FINALE DEMO:  ${saldoFinale} $   (${saldoFinale - CFG.CAPITALE >= 0 ? "+" : ""}${r2(saldoFinale - CFG.CAPITALE)} $)`);
  log(`════════════════════════════════════════════════════`);
  try {
    fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CFG.OUT_DIR, "riepilogo.txt"),
      `capitale ${CFG.CAPITALE}\ncontante ${r2(PF.contante)}\ninvestito ${r2(PF.investito)}\n` +
      `saldo_finale ${saldoFinale}\npnl ${r2(saldoFinale - CFG.CAPITALE)}\n` +
      `round ${PF.roundGiocati}\nvinti ${PF.roundVinti}\npersi ${PF.roundPersi}\nfee ${r2(PF.feeTotali)}\n`);
  } catch (_) {}
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  log("═══════════════════════════════════════════════");
  log("  xreal v1.0 · PAPER con PORTAFOGLIO DEMO");
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
    const prima = PF.roundGiocati;
    try { await eseguiRound(r); } catch (e) { log("[err]", e.message); }
    if (PF.roundGiocati > prima) fatti++;
    await sleep(Math.max(1000, (start + WINDOW) * 1000 - Date.now() + 2000));
  }

  riepilogo();
  log(`\n[exit] ${fatti} round — il job termina, l'upload parte`);
  process.exit(0);
}

process.on("SIGINT", () => { riepilogo(); process.exit(0); });
process.on("SIGTERM", () => { riepilogo(); process.exit(0); });
main().catch((e) => { console.error(e); process.exit(1); });
