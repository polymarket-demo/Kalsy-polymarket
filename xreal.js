// ═══════════════════════════════════════════════════════════════════════════
// xreal.js — v3.0 · PAPER con CONTABILITÀ CORRETTA
//
// COSA ERA SBAGLIATO NELLA v2
//   Il bot non scalava il costo del secondo lato della coppia quando chiudeva
//   il round: accreditava il ricavo (5,00) senza sottrarre il costo sostenuto.
//   Risultato: ogni coppia sembrava un guadagno e il riepilogo saliva da solo.
//   Il riepilogo diceva +86,80 $ su 50 round; il conto vero sui tick era -24,52 $.
//
// COSA FA QUESTA VERSIONE
//   1. UNA sola fonte di verità: il contante. Ogni round parte da `contante` e
//      torna a `contante`. Il PNL del round e' saldoDopo - saldoPrima, sempre.
//   2. Ogni posizione aperta ha un `costo` e resta in una lista `aperte` finche'
//      non viene chiusa (uscita, trailing, o scadenza). Quando si chiude,
//      si incassa il valore reale e si toglie il costo. Mai due volte.
//   3. A fine round TUTTE le posizioni residue vengono liquidate (vince = 1.00,
//      perde = 0) e il contante aggiornato. Nessuna posizione "dimenticata".
//   4. Il riepilogo NON ricalcola: legge il contante. Se contante + aperte !=
//      capitale + somma(pnl dei round), il run e' incoerente e lo dichiara.
//   5. Controllo di quadratura a fine run: la somma dei PNL di tutti i round
//      deve coincidere col saldo. Se non coincide, lo scrive nel riepilogo e
//      nel log con "QUADRATURA FALLITA" invece di nasconderlo.
//
// DATI: reali (WebSocket Polymarket). PORTAFOGLIO: demo. ORDINI: simulati.
// ═══════════════════════════════════════════════════════════════════════════

import WebSocket from "ws";
import fs from "fs";
import path from "path";

const CFG = {
  CAPITALE: 50,
  SHARES: 5,
  SHARES_AGG: 5,
  QUOTA: 0.46,
  SOGLIA_AGG: 0.50,
  AGG_DOPO_S: 90,
  AGG_BID_MIN: 0.42,
  TRAILING: 0.90,
  USCITA: 0.40,
  USCITA_MIN_S: 60,
  PREZZO_MIN_FILL: 0.25,
  RESTA_MIN: 3,            // il prezzo deve restare >= 3 tick per contare il fill
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

// ─── PORTAFOGLIO: una sola fonte di verità ─────────────────────────────────
const PF = {
  contante: CFG.CAPITALE,
  aperte: [],               // posizioni non ancora chiuse: {lato,prezzo,shares,costo,slug}
  pnlRound: [],             // PNL di ogni round chiuso
  roundGiocati: 0, roundSaltati: 0,
  feeTotali: 0,
};

const investito = () => r4(PF.aperte.reduce((s, p) => s + p.costo, 0));
const saldoTotale = () => r4(PF.contante + investito());

// apre una posizione: esce contante, entra in `aperte`. Ritorna la posizione.
function apri(lato, prezzo, shares, slug, t, ordini, tipo) {
  const costo = r4(prezzo * shares);
  if (costo > PF.contante + 1e-9) {
    ordini.push({ slug, t, lato, tipo: "RIFIUTATO", prezzo, shares, costo, nota: "contante insufficiente" });
    log(`    ✋ ${tipo} ${lato} RIFIUTATO: serve ${costo} $ ma contante ${r2(PF.contante)} $`);
    return null;
  }
  PF.contante = r4(PF.contante - costo);
  const pos = { lato, prezzo, shares, costo, slug, t };
  PF.aperte.push(pos);
  ordini.push({ slug, t, lato, tipo, prezzo, shares, costo, nota: `contante dopo ${r2(PF.contante)}` });
  log(`    → ${tipo} ${lato} ${shares}@${prezzo} = ${costo} $ | contante ${r2(PF.contante)} $`);
  return pos;
}

// chiude una posizione: incassa `valore` per share, toglie il costo. UNA volta.
function chiudi(pos, prezzoUscita, tipo, t, ordini, feeRate = 0) {
  const idx = PF.aperte.indexOf(pos);
  if (idx === -1) return null;                       // già chiusa: niente doppioni
  PF.aperte.splice(idx, 1);
  const incasso = r4(prezzoUscita * pos.shares);
  const fee = feeRate ? r4(feeRate * prezzoUscita * (1 - prezzoUscita) * pos.shares) : 0;
  PF.contante = r4(PF.contante + incasso - fee);
  PF.feeTotali = r4(PF.feeTotali + fee);
  const pnl = r4(incasso - fee - pos.costo);
  ordini.push({ slug: pos.slug, t, lato: pos.lato, tipo, prezzo: prezzoUscita, shares: pos.shares,
                costo: pos.costo, nota: `incasso ${incasso} pnl ${pnl}` });
  log(`    ← ${tipo} ${pos.lato} a ${prezzoUscita} = ${incasso} $ (pnl ${pnl >= 0 ? "+" : ""}${pnl}) | contante ${r2(PF.contante)} $`);
  return pnl;
}

function feeSuFill() { return 0; }

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

// fill "onesto": il prezzo deve RESTARE per RESTA_MIN tick consecutivi
function fillOnesto(storico, lato, quota, shares) {
  for (let k = 0; k < storico.length; k++) {
    const x = storico[k][lato];
    if (!x || x.ask === null || x.ask > quota || x.size < shares) continue;
    let resta = 0;
    for (let j = k; j < storico.length; j++) {
      const y = storico[j][lato];
      if (y.ask !== null && y.ask <= quota + 0.005 && y.size >= shares) resta++;
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
  log(`    saldo prima: ${saldoTotale()} $ (contante ${r2(PF.contante)} + investito ${investito()})`);

  const saldoPrima = saldoTotale();
  const contantePrima = PF.contante;
  const apertePrima = PF.aperte.length;

  const reader = new BookReader([r.upToken, r.dnToken].filter(Boolean));
  reader.start();

  const inizio = roundStart();
  const storico = [];
  const ordini = [];
  const tick = [];
  const mie = [];                                    // posizioni di QUESTO round
  let agg = null, decisione = null, avviso = false;
  let filtroPassato = !CFG.FILTRO_ON ? true : null, sommaInizio = null;
  let tUp = null, tDn = null, minUp = 9, minDn = 9;

  while (Math.floor(Date.now() / 1000) - inizio < WINDOW) {
    const t = (Date.now() - inizio * 1000) / 1000;
    const [up, dn] = await Promise.all([reader.leggi(r.upToken), reader.leggi(r.dnToken)]);
    if (!up || !dn) { await sleep(CFG.POLL_MS); continue; }

    const punto = { t: +t.toFixed(1),
      up: { ask: up.bestAsk, size: up.askSize, bid: up.bestBid },
      dn: { ask: dn.bestAsk, size: dn.askSize, bid: dn.bestBid } };
    storico.push(punto);
    tick.push({ t: punto.t, up: up.bestAsk, dn: dn.bestAsk, askUp: up.askSize, askDn: dn.askSize, bidUp: up.bestBid, bidDn: dn.bestBid });
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

    // ── APERTURA: ogni lato quando il SUO prezzo resta a <= quota
    for (const lato of ["up", "dn"]) {
      if (mie.find((p) => p.lato === lato)) continue;
      const f = fillOnesto(storico, lato, CFG.QUOTA, CFG.SHARES);
      if (f) {
        const p = apri(lato, f.prezzo, CFG.SHARES, r.slug, punto.t, ordini, "APERTURA");
        if (p) { mie.push(p); if (lato === "up") tUp = punto.t; else tDn = punto.t; }
      }
    }

    // ── AGGIUNTA: solo su UN lato scoperto, dopo AGG_DOPO_S, se il lato e' vivo
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
            const np = apri(p0.lato, prezzoFill, CFG.SHARES_AGG, r.slug, punto.t, ordini, "AGGIUNTA");
            if (np) { agg = { ...np, pos: np, haToccato: false, chiuso: false }; }
          }
        }
      }
    }

    // ── TRAILING sull'aggiunta
    if (agg && !agg.chiuso) {
      const book = agg.lato === "up" ? up : dn;
      const bid = book.bestBid;
      if (bid !== null) {
        if (!agg.haToccato && bid >= CFG.TRAILING) { agg.haToccato = true; log(`    ↑ ${agg.lato} tocca ${CFG.TRAILING}`); }
        else if (agg.haToccato && bid <= CFG.TRAILING) {
          agg.chiuso = true;
          chiudi(agg.pos, bid, "TRAILING", punto.t, ordini, r.feeRate);
          mie.splice(mie.indexOf(agg.pos), 1);
        }
      }
    }

    // ── USCITA sul lato perdente (solo se ho un lato solo, senza aggiunta)
    if (!decisione && !agg && mie.length === 1) {
      const p = mie[0];
      const book = p.lato === "up" ? up : dn;
      if (book.bestBid !== null && (t - p.t) >= CFG.USCITA_MIN_S && book.bestBid <= CFG.USCITA) {
        chiudi(p, book.bestBid, "USCITA", punto.t, ordini, r.feeRate);
        mie.splice(0, 1);
        decisione = "USCITA";
      }
    }
    if (!decisione && mie.length >= 2) decisione = "COPPIA";

    await sleep(CFG.POLL_MS);
  }
  reader.stop();

  // ── SCADENZA: liquida TUTTO quello che resta in mano (vince=1.00, perde=0)
  const ultimo = tick[tick.length - 1] || {};
  const finUp = ultimo.up ?? 0, finDn = ultimo.dn ?? 0;
  for (const p of [...mie]) {
    const vince = p.lato === "up" ? finUp > finDn : finDn > finUp;
    chiudi(p, vince ? 1.0 : 0.0, "SCADENZA", 300, ordini, 0);
  }

  // ── salvataggi dei tick (semantica pulita: i tick sono sempre i valori del libro)
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
    "slug,contratto,saldo_prima,saldo_dopo,pnl_round,contante_dopo,investito_dopo,esito,coppia,aggiunta,trailing,uscita,saltato,note",
    [[r.slug, "xreal-v3", r2(saldoPrima), r2(saldoDopo), pnlRound, r2(PF.contante), investito(),
      decisione ?? (saltato ? "SALTATO" : "FINE"), mie.length >= 2 ? "si" : "no", agg ? "si" : "no",
      agg?.chiuso ? "si" : "no", decisione === "USCITA" ? "si" : "no", saltato ? "si" : "no",
      `up ${finUp} dn ${finDn}`].join(",")]);
  salvaCsv("coppie.csv", "slug,up_min,dn_min,t_up_fill,t_dn_fill,coppia_presa,somma_ask_inizio,esito,motivo",
    [[r.slug, minUp === 9 ? "" : minUp.toFixed(3), minDn === 9 ? "" : minDn.toFixed(3), tUp ?? "", tDn ?? "",
      (tUp !== null && tDn !== null) ? "SI" : "NO", sommaInizio ?? "", decisione ?? (saltato ? "SALTATO" : "FINE"),
      saltato ? "filtro" : (tUp !== null && tDn !== null ? "coppia piena" : "un solo lato")].join(",")]);

  log(`>>> ${r.slug} | ${decisione ?? (saltato ? "SALTATO" : "FINE")} | PNL ${pnlRound >= 0 ? "+" : ""}${pnlRound} $ | saldo ${saldoDopo} $`);
  return pnlRound;
}

function riepilogo() {
  const invest = investito();
  const saldoFinale = r2(PF.contante + invest);
  const sommaPnl = r4(PF.pnlRound.reduce((s, x) => s + x.pnl, 0));
  const atteso = r4(CFG.CAPITALE + sommaPnl);
  const quadra = Math.abs(atteso - saldoFinale) < 0.02;

  log(`\n═══════════ RIEPILOGO (demo, v3 contabilità corretta) ═══════════`);
  log(`  capitale iniziale:   ${CFG.CAPITALE} $`);
  log(`  contante:            ${r2(PF.contante)} $`);
  log(`  posizioni aperte:    ${invest} $`);
  log(`  SALDO:               ${saldoFinale} $`);
  log(`  somma PNL dei round: ${sommaPnl} $  (${PF.roundGiocati} round giocati, ${PF.roundSaltati} saltati)`);
  log(`  quadratura:          ${quadra ? "OK" : "QUADRATURA FALLITA"} (atteso ${atteso} vs saldo ${saldoFinale})`);
  log(`═════════════════════════════════════════════════════════════════`);

  try {
    fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CFG.OUT_DIR, "riepilogo.txt"),
      `contratto xreal-v3\ncapitale ${CFG.CAPITALE}\ncontante ${r2(PF.contante)}\nposizioni_aperte ${invest}\n` +
      `saldo_finale ${saldoFinale}\nsomma_pnl_round ${sommaPnl}\nround_giocati ${PF.roundGiocati}\n` +
      `round_saltati ${PF.roundSaltati}\nquadratura ${quadra ? "OK" : "FALLITA"}\natteso ${atteso}\n`);
  } catch (_) {}
}

async function main() {
  log("═══════════════════════════════════════════════");
  log("  xreal v3.0 · paper DEMO · contabilità corretta");
  log("═══════════════════════════════════════════════");
  log(`  capitale ${CFG.CAPITALE} $ · ${CFG.SHARES} share · quota ${CFG.QUOTA} · agg ${CFG.SOGLIA_AGG} dopo ${CFG.AGG_DOPO_S}s`);
  log(`  trailing ${CFG.TRAILING} · uscita ${CFG.USCITA} · fill con permanenza ${CFG.RESTA_MIN} tick`);

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
