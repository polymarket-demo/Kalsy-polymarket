// ═══════════════════════════════════════════════════════════════════════════
// xreal.js — v4.0 · PAPER DEMO · ESITO LETTO DALLA FONTE VERA
//
// COSA ERA SBAGLIATO NELLA v3
//   Il bot decideva chi aveva vinto confrontando i due best ask finali del
//   book. Ma a fine round il book e' svuotato: restano residui a 0,00-0,01,
//   e il confronto tra 0,01 e 0,001 NON e' il risultato del mercato.
//   Verificato contro Polymarket: 3 esiti sbagliati su 9 round (67% giusti).
//   Ogni esito sbagliato = un incasso "1.00" inventato su un lato che aveva
//   perso -> il PNL v3 e' gonfiato e inaffidabile.
//
// COSA FA QUESTA VERSIONE
//   1. A fine round legge l'esito VERO dal mercato (Gamma API):
//      outcomePrices = ["1","0"] -> ha vinto UP ; ["0","1"] -> ha vinto DOWN.
//      Se la lettura fallisce, il round viene marcato ESITO_NON_LETTO e le
//      posizioni residue vengono chiuse al VALORE OSSERVATO (non a 1.00):
//      meglio un round incerto che un round inventato.
//   2. Il PNL di ogni round viene scritto nel CSV INSIEME all'esito letto,
//      cosi' e' verificabile riga per riga contro il sito.
//   3. Contabilità a fonte unica (come v3) + quadratura dichiarata.
//   4. `esiti.csv` registra slug, esito letto da Gamma, esito dedotto dai
//      tick, e se i due coincidono: il confronto e' esplicito nel run.
//
// DATI: reali (WebSocket + Gamma). PORTAFOGLIO: demo. ORDINI: simulati.
// ═══════════════════════════════════════════════════════════════════════════

import WebSocket from "ws";
import fs from "fs";
import path from "path";

const CFG = {
  CAPITALE: 50,
  SHARES: 5,
  SHARES_AGG: 5,
  QUOTA: 0.46,
  PREZZO_MIN_FILL: 0.25,   // NON comprare sotto questo prezzo (residui del book)
  SOGLIA_AGG: 0.50,
  AGG_DOPO_S: 90,
  AGG_BID_MIN: 0.42,
  TRAILING: 0.90,
  USCITA: 0.40,
  USCITA_MIN_S: 60,
  RESTA_MIN: 3,
  MAX_ROUNDS: 10,
  POLL_MS: 1000,
  FILTRO_ON: true,
  FILTRO_SOMMA_MIN: 0.70,
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

const PF = { contante: CFG.CAPITALE, aperte: [], pnlRound: [], roundGiocati: 0, roundSaltati: 0 };
const investito = () => r4(PF.aperte.reduce((s, p) => s + p.costo, 0));
const saldoTotale = () => r4(PF.contante + investito());

function apri(lato, prezzo, shares, slug, t, ordini, tipo) {
  const costo = r4(prezzo * shares);
  if (costo > PF.contante + 1e-9) {
    ordini.push({ slug, t, lato, tipo: "RIFIUTATO", prezzo, shares, costo, nota: "contante insufficiente" });
    log(`    ✋ ${tipo} ${lato} RIFIUTATO (serve ${costo} $, contante ${r2(PF.contante)} $)`);
    return null;
  }
  PF.contante = r4(PF.contante - costo);
  const pos = { lato, prezzo, shares, costo, slug, t };
  PF.aperte.push(pos);
  ordini.push({ slug, t, lato, tipo, prezzo, shares, costo, nota: `contante dopo ${r2(PF.contante)}` });
  log(`    → ${tipo} ${lato} ${shares}@${prezzo} = ${costo} $ | contante ${r2(PF.contante)} $`);
  return pos;
}

function chiudi(pos, prezzoUscita, tipo, t, ordini, feeRate = 0) {
  const idx = PF.aperte.indexOf(pos);
  if (idx === -1) return null;
  PF.aperte.splice(idx, 1);
  const incasso = r4(prezzoUscita * pos.shares);
  const fee = feeRate ? r4(feeRate * prezzoUscita * (1 - prezzoUscita) * pos.shares) : 0;
  PF.contante = r4(PF.contante + incasso - fee);
  const pnl = r4(incasso - fee - pos.costo);
  ordini.push({ slug: pos.slug, t, lato: pos.lato, tipo, prezzo: prezzoUscita, shares: pos.shares,
                costo: pos.costo, nota: `incasso ${incasso} pnl ${pnl}` });
  log(`    ← ${tipo} ${pos.lato} a ${prezzoUscita} = ${incasso} $ (pnl ${pnl >= 0 ? "+" : ""}${pnl})`);
  return pnl;
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

// ─── ESITO VERO DAL MERCATO ────────────────────────────────────────────────
// outcomePrices e' l'array dei prezzi finali: il vincitore ha "1".
// Il primo outcome di questi mercati e' "Up", il secondo "Down".
async function esitoVero(slug) {
  for (let tentativo = 1; tentativo <= 3; tentativo++) {
    try {
      const ev = await jget(`${GAMMA}/events?slug=${slug}`);
      const m = ev?.[0]?.markets?.[0];
      if (!m) { await sleep(2000); continue; }
      let prices = m.outcomePrices;
      if (typeof prices === "string") prices = JSON.parse(prices);
      let outcomes = m.outcomes;
      if (typeof outcomes === "string") outcomes = JSON.parse(outcomes);
      if (!Array.isArray(prices) || prices.length < 2) { await sleep(2000); continue; }
      const p0 = parseFloat(prices[0]), p1 = parseFloat(prices[1]);
      // non ancora risolto: entrambi lontani da 1
      if (Math.max(p0, p1) < 0.99) { await sleep(2500); continue; }
      const nome0 = (outcomes?.[0] ?? "Up").toString().toLowerCase();
      const nome1 = (outcomes?.[1] ?? "Down").toString().toLowerCase();
      const vincitoreNome = p0 >= p1 ? nome0 : nome1;
      const lato = vincitoreNome.startsWith("up") ? "up" : "dn";
      return { lato, prices: [p0, p1], outcomes: [nome0, nome1], fonte: "gamma" };
    } catch (e) { await sleep(2000); }
  }
  return null;
}

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
    try { this.ws = new WebSocket(CFG.WS_URL); } catch (e) { this._riprova(); return; }
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
    this.ws.on("close", () => { clearInterval(this.pingTimer); clearTimeout(this.openTimer); this.wsCaduto++;
      if (!this.chiuso) { log(`[ws] chiuso (#${this.wsCaduto})`); this._riprova(); } });
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

function fillOnesto(storico, lato, quota, shares) {
  for (let k = 0; k < storico.length; k++) {
    const x = storico[k][lato];
    if (!x || x.ask === null || x.ask > quota || x.ask < CFG.PREZZO_MIN_FILL || x.size < shares) continue;
    let resta = 0;
    for (let j = k; j < storico.length; j++) {
      const y = storico[j][lato];
      if (y.ask !== null && y.ask <= quota + 0.005 && y.ask >= CFG.PREZZO_MIN_FILL && y.size >= shares) resta++;
      else break;
    }
    if (resta >= CFG.RESTA_MIN) return { i: k, prezzo: x.ask, resta };
    k += Math.max(0, resta - 1);
  }
  return null;
}

function salvaCsv(nome, intestazione, righe) {
  try {
    fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
    const f = path.join(CFG.OUT_DIR, nome);
    if (!fs.existsSync(f)) fs.writeFileSync(f, intestazione + "\n");
    if (righe.length) fs.appendFileSync(f, righe.join("\n") + "\n");
  } catch (e) { log("[err]", nome, e.message); }
}

async function eseguiRound(r) {
  log(`\n${"=".repeat(70)}`);
  log(`ROUND ${r.slug} | ${r.title} | fee ${(r.feeRate * 10000).toFixed(0)} bps`);

  const saldoPrima = saldoTotale();
  const reader = new BookReader([r.upToken, r.dnToken].filter(Boolean));
  reader.start();

  const inizio = roundStart();
  const storico = [], ordini = [], tick = [], mie = [];
  let agg = null, decisione = null, avviso = false;
  let filtroPassato = !CFG.FILTRO_ON ? true : null, sommaInizio = null;
  let tUp = null, tDn = null, minUp = 9, minDn = 9;

  while (Math.floor(Date.now() / 1000) - inizio < WINDOW) {
    const t = (Date.now() - inizio * 1000) / 1000;
    const [up, dn] = await Promise.all([reader.leggi(r.upToken), reader.leggi(r.dnToken)]);
    if (!up || !dn) { await sleep(CFG.POLL_MS); continue; }

    storico.push({ t: +t.toFixed(1),
      up: { ask: up.bestAsk, size: up.askSize, bid: up.bestBid },
      dn: { ask: dn.bestAsk, size: dn.askSize, bid: dn.bestBid } });
    tick.push({ t: +t.toFixed(1), up: up.bestAsk, dn: dn.bestAsk, askUp: up.askSize, askDn: dn.askSize, bidUp: up.bestBid, bidDn: dn.bestBid });
    if (up.bestAsk) minUp = Math.min(minUp, up.bestAsk);
    if (dn.bestAsk) minDn = Math.min(minDn, dn.bestAsk);

    if (filtroPassato === null && t >= CFG.FILTRO_DOPO_S && up.bestAsk && dn.bestAsk) {
      sommaInizio = r4(up.bestAsk + dn.bestAsk);
      filtroPassato = sommaInizio >= CFG.FILTRO_SOMMA_MIN;
      log(filtroPassato ? `    ✓ filtro: somma ${sommaInizio} → si entra`
                        : `    ✋ FILTRO: somma ${sommaInizio} < ${CFG.FILTRO_SOMMA_MIN} → round saltato`);
    }
    if (filtroPassato === false) {
      if (Math.floor(Date.now() / 1000) - inizio >= WINDOW - 1) break;
      await sleep(CFG.POLL_MS); continue;
    }

    for (const lato of ["up", "dn"]) {
      if (mie.find((p) => p.lato === lato)) continue;
      const f = fillOnesto(storico, lato, CFG.QUOTA, CFG.SHARES);
      if (f) {
        const p = apri(lato, f.prezzo, CFG.SHARES, r.slug, +t.toFixed(1), ordini, "APERTURA");
        if (p) { mie.push(p); if (lato === "up") tUp = +t.toFixed(1); else tDn = +t.toFixed(1); }
      }
    }

    if (mie.length >= 2 && !agg && !avviso) { avviso = true; log(`    ⊘ coppia completa → nessuna aggiunta`); }
    if (!agg && mie.length === 1) {
      const p0 = mie[0];
      if ((t - p0.t) >= CFG.AGG_DOPO_S) {
        const book = p0.lato === "up" ? up : dn;
        if (book.bestBid !== null && book.bestBid < CFG.AGG_BID_MIN) {
          if (!avviso) { avviso = true; log(`    ⊘ lato ${p0.lato} in discesa (bid ${book.bestBid}) → nessuna aggiunta`); }
        } else if (book.bestAsk !== null && book.bestAsk >= CFG.SOGLIA_AGG && book.bestAsk < 0.97) {
          const prezzoFill = Math.min(book.bestAsk, CFG.SOGLIA_AGG);
          if (book.askSize >= CFG.SHARES_AGG) {
            const np = apri(p0.lato, prezzoFill, CFG.SHARES_AGG, r.slug, +t.toFixed(1), ordini, "AGGIUNTA");
            if (np) agg = { ...np, pos: np, haToccato: false, chiuso: false };
          }
        }
      }
    }

    if (agg && !agg.chiuso) {
      const book = agg.lato === "up" ? up : dn;
      const bid = book.bestBid;
      if (bid !== null) {
        if (!agg.haToccato && bid >= CFG.TRAILING) { agg.haToccato = true; log(`    ↑ ${agg.lato} tocca ${CFG.TRAILING}`); }
        else if (agg.haToccato && bid <= CFG.TRAILING) {
          agg.chiuso = true;
          chiudi(agg.pos, bid, "TRAILING", +t.toFixed(1), ordini, r.feeRate);
          mie.splice(mie.indexOf(agg.pos), 1);
        }
      }
    }

    if (!decisione && !agg && mie.length === 1) {
      const p = mie[0];
      const book = p.lato === "up" ? up : dn;
      if (book.bestBid !== null && (t - p.t) >= CFG.USCITA_MIN_S && book.bestBid <= CFG.USCITA) {
        chiudi(p, book.bestBid, "USCITA", +t.toFixed(1), ordini, r.feeRate);
        mie.splice(0, 1); decisione = "USCITA";
      }
    }
    if (!decisione && mie.length >= 2) decisione = "COPPIA";

    await sleep(CFG.POLL_MS);
  }
  reader.stop();

  // ── ESITO: prima dedotto dai tick (per confronto), poi LETTO da Gamma
  const ultimo = tick[tick.length - 1] || {};
  const finUp = ultimo.up ?? 0, finDn = ultimo.dn ?? 0;
  const esitoDedotto = finUp > finDn ? "up" : "dn";

  log(`    esito dedotto dai tick: ${esitoDedotto} (up ${finUp} / dn ${finDn}) — ora leggo il vero...`);
  const vero = await esitoVero(r.slug);
  const LATO_VINCENTE = vero ? vero.lato : esitoDedotto;
  const fonte = vero ? "gamma" : "dedotto";
  if (vero) {
    log(`    ✔ ESITO VERO: ${vero.lato} (outcomePrices ${vero.prices.join("/")}, outcomes ${vero.outcomes.join("/")})`);
    if (vero.lato !== esitoDedotto) log(`    ⚠️ i tick dicevano ${esitoDedotto} → la deduzione era SBAGLIATA`);
  } else {
    log(`    ⚠️ esito non letto da Gamma: chiudo le residue al valore osservato (nessuna assunzione)`);
  }

  // ── liquidazione delle posizioni residue
  for (const p of [...mie]) {
    let prezzo;
    if (vero) prezzo = (p.lato === LATO_VINCENTE) ? 1.0 : 0.0;
    else prezzo = p.lato === "up" ? Math.min(finUp, 0.99) : Math.min(finDn, 0.99);  // valore osservato
    chiudi(p, prezzo, vero ? "SCADENZA_ESITO" : "SCADENZA_VALORE_OSSERVATO", 300, ordini, vero ? 0 : r.feeRate);
  }

  try {
    fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CFG.OUT_DIR, `${r.slug}.csv`),
      "t,up_ask,up_size,dn_ask,dn_size,up_bid,dn_bid\n" +
      tick.map((x) => [x.t, x.up ?? "", Math.round(x.askUp || 0), x.dn ?? "", Math.round(x.askDn || 0), x.bidUp ?? "", x.bidDn ?? ""].join(",")).join("\n"));
  } catch (e) { log("[err] tick:", e.message); }

  const saldoDopo = saldoTotale();
  const pnlRound = r4(saldoDopo - saldoPrima);
  const saltato = filtroPassato === false;
  if (saltato) PF.roundSaltati++;
  else { PF.roundGiocati++; PF.pnlRound.push({ slug: r.slug, pnl: pnlRound }); }

  salvaCsv("ordini.csv", "slug,t,lato,tipo,prezzo,shares,costo,nota",
    ordini.map((o) => [o.slug, o.t ?? "", o.lato, o.tipo, o.prezzo ?? "", o.shares ?? "", o.costo ?? "", o.nota ?? ""].join(",")));
  salvaCsv("portfolio.csv",
    "slug,saldo_prima,saldo_dopo,pnl_round,contante_dopo,investito_dopo,esito,fonte_esito,coppia,aggiunta,trailing,uscita,saltato,note",
    [[r.slug, r2(saldoPrima), r2(saldoDopo), pnlRound, r2(PF.contante), investito(),
      decisione ?? (saltato ? "SALTATO" : "FINE"), fonte, mie.length >= 2 ? "si" : "no", agg ? "si" : "no",
      agg?.chiuso ? "si" : "no", decisione === "USCITA" ? "si" : "no", saltato ? "si" : "no",
      `up ${finUp} dn ${finDn}`].join(",")]);
  salvaCsv("esiti.csv", "slug,esito_vero,esito_dedotto_dai_tick,coincidono,fonte,up_min,dn_min,coppia_presa,t_up_fill,t_dn_fill",
    [[r.slug, vero ? vero.lato : "", esitoDedotto, vero ? (vero.lato === esitoDedotto ? "SI" : "NO") : "", fonte,
      minUp === 9 ? "" : minUp.toFixed(3), minDn === 9 ? "" : minDn.toFixed(3),
      (tUp !== null && tDn !== null) ? "SI" : "NO", tUp ?? "", tDn ?? ""].join(",")]);

  log(`>>> ${r.slug} | esito ${LATO_VINCENTE} (${fonte}) | PNL ${pnlRound >= 0 ? "+" : ""}${pnlRound} $ | saldo ${saldoDopo} $`);
  return pnlRound;
}

function riepilogo() {
  const invest = investito();
  const saldoFinale = r2(PF.contante + invest);
  const sommaPnl = r4(PF.pnlRound.reduce((s, x) => s + x.pnl, 0));
  const atteso = r4(CFG.CAPITALE + sommaPnl);
  const quadra = Math.abs(atteso - saldoFinale) < 0.02;
  log(`\n═══════════ RIEPILOGO (demo, v4 esito da Gamma) ═══════════`);
  log(`  capitale ${CFG.CAPITALE} $ · contante ${r2(PF.contante)} $ · aperte ${invest} $`);
  log(`  SALDO ${saldoFinale} $ · somma PNL round ${sommaPnl} $ (${PF.roundGiocati} giocati, ${PF.roundSaltati} saltati)`);
  log(`  quadratura: ${quadra ? "OK" : "FALLITA"} (atteso ${atteso})`);
  log(`══════════════════════════════════════════════════════════`);
  try {
    fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CFG.OUT_DIR, "riepilogo.txt"),
      `contratto xreal-v4-esito-gamma\ncapitale ${CFG.CAPITALE}\ncontante ${r2(PF.contante)}\nposizioni_aperte ${invest}\n` +
      `saldo_finale ${saldoFinale}\nsomma_pnl_round ${sommaPnl}\nround_giocati ${PF.roundGiocati}\n` +
      `round_saltati ${PF.roundSaltati}\nquadratura ${quadra ? "OK" : "FALLITA"}\natteso ${atteso}\n`);
  } catch (_) {}
}

async function main() {
  log("═══════════════════════════════════════════════");
  log("  xreal v4.0 · paper DEMO · esito letto da Gamma");
  log("═══════════════════════════════════════════════");
  log(`  capitale ${CFG.CAPITALE} $ · ${CFG.SHARES} share · quota ${CFG.QUOTA} (min ${CFG.PREZZO_MIN_FILL})`);
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
  process.exit(0);
}

process.on("SIGINT", () => { riepilogo(); process.exit(0); });
process.on("SIGTERM", () => { riepilogo(); process.exit(0); });
main().catch((e) => { console.error(e); process.exit(1); });
