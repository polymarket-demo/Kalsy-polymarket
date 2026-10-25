// ═══════════════════════════════════════════════════════════════════════════
// xreal.js — v6.0 · SOLO FATTI, NIENTE CONTI
//
// FILOSOFIA: il bot NON calcola piu' il PNL, il saldo, la somma.
//   Scrive solo i fatti: ogni ordine, ogni tick, ogni esito letto.
//   Il PNL si calcola FUORI, dai fatti, e si puo' rifare a mano.
//   Cosi' non esiste un secondo conto che puo' sbagliare in silenzio.
//
// STRATEGIA (parametri dell'utente, non toccare):
//   1. ENTRATA: compra entrambi i lati a 0,46 (UP e DN)
//   2. RICOMPRA: il PRIMO dei due lati che arriva a 0,90 -> +5 share su quel lato
//   3. USCITA del lato ricomprato: se riscende sotto 0,70 vende;
//      se tiene fino alla fine, resta fino alla fine del round
//   4. USCITA 0,40: il lato perdente esce a 0,40 dopo 60 secondi (sempre attiva)
//   5. FILTRO: se il round parte sbilanciato (un lato >= 0,70 e l'altro <= 0,30)
//      NON entra
//   6. ESITO: letto dalla Gamma API a fine round. Se non e' leggibile,
//      il round e' PENDENTE e NON entra nel conteggio.
//
// FILE SCRITTI (tutti in out-real/):
//   ordini.csv    slug,t,lato,tipo,prezzo,shares,valore,nota
//   tick.csv      slug,t,up_ask,up_size,dn_ask,dn_size,up_bid,dn_bid
//   esiti.csv     slug,esito_letto,prezzi_gamma,outcomes,fonte,stato
//   round.csv     slug,ora_inizio,ora_fine,entrata,filtro,motivo,completo
//   README.txt    cosa c'e' in ogni file, per il conto esterno
// ═══════════════════════════════════════════════════════════════════════════

import WebSocket from "ws";
import fs from "fs";
import path from "path";

const CFG = {
  SHARES: 5,
  QUOTA: 0.48,              // entrambi i lati comprano qui
  PREZZO_MIN_FILL: 0.05,
  RICOMPRA: 5,              // share della ricompra
  RICOMPRA_A: 0.90,         // il lato tocca qui -> ricompra
  VENDI_SOTTO: 0.70,        // il lato ricomprato vende se riscende sotto
  USCITA: 0.40,             // lato perdente esce qui
  USCITA_MIN_S: 60,
  FILTRO_ALTO: 0.70,        // sbilanciamento: un lato >= a questo
  FILTRO_BASSO: 0.30,       // e l'altro <= a questo -> non entra
  FILTRO_DOPO_S: 3,
  MAX_ROUNDS: 10,
  POLL_MS: 1000,
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
const r3 = (x) => Math.round(x * 1000) / 1000;

async function jget(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const roundStart = (now = Date.now()) => Math.floor(now / 1000 / WINDOW) * WINDOW;

// ─── SCRITTURA: solo fatti, in append, mai ricalcoli ───────────────────────
const OUT = () => { fs.mkdirSync(CFG.OUT_DIR, { recursive: true }); return CFG.OUT_DIR; };
function append(nome, intestazione, righe) {
  try {
    const f = path.join(OUT(), nome);
    if (!fs.existsSync(f)) fs.writeFileSync(f, intestazione + "\n");
    if (righe.length) fs.appendFileSync(f, righe.join("\n") + "\n");
  } catch (e) { log("[err]", nome, e.message); }
}

// gli ordini di questo round, raccolti e scritti in blocco a fine round
let ORDINI = [];
let SLUG_CORRENTE = "";

function ordine(t, lato, tipo, prezzo, shares, nota) {
  const valore = r3(prezzo * shares);
  ORDINI.push([SLUG_CORRENTE, t ?? "", lato, tipo, prezzo, shares, valore, nota ?? ""].join(","));
  log(`    → ${tipo} ${lato} ${shares}@${prezzo} = ${valore} $${nota ? " | " + nota : ""}`);
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
    return { slug, title: ev[0].title, upToken: tokens?.[0] ?? null, dnToken: tokens?.[1] ?? null };
  } catch (e) { log("[warn] gamma:", e.message); return null; }
}

// ─── ESITO: letto, mai dedotto. Ritorna null se non leggibile. ─────────────
async function leggiEsito(slug) {
  try {
    const ev = await jget(`${GAMMA}/events?slug=${slug}`);
    const m = ev?.[0]?.markets?.[0];
    if (!m) return { stato: "NON_TROVATO" };
    let prices = m.outcomePrices; if (typeof prices === "string") prices = JSON.parse(prices);
    let outcomes = m.outcomes;    if (typeof outcomes === "string") outcomes = JSON.parse(outcomes);
    if (!Array.isArray(prices) || prices.length < 2) return { stato: "NON_RISOLTO" };
    const p0 = parseFloat(prices[0]), p1 = parseFloat(prices[1]);
    if (Math.max(p0, p1) < 0.99) return { stato: "NON_RISOLTO", prezzi: `${p0}/${p1}` };
    const n0 = (outcomes?.[0] ?? "Up").toString().toLowerCase();
    const n1 = (outcomes?.[1] ?? "Down").toString().toLowerCase();
    const lato = (p0 >= p1 ? n0 : n1).startsWith("up") ? "up" : "dn";
    return { stato: "LETTO", lato, prezzi: `${p0}/${p1}`, outcomes: `${n0}/${n1}` };
  } catch (e) { return { stato: `ERRORE ${e.message}` }; }
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
             askSize: sA.length ? sA[0][1] : 0 };
  }
}

// ─── UN ROUND ──────────────────────────────────────────────────────────────
async function eseguiRound(r) {
  log(`\n${"=".repeat(70)}`);
  log(`ROUND ${r.slug} | ${r.title}`);
  SLUG_CORRENTE = r.slug;
  ORDINI = [];

  const reader = new BookReader([r.upToken, r.dnToken].filter(Boolean));
  reader.start();

  const inizio = roundStart();
  const tickRighe = [];
  const comprato = { up: false, dn: false };
  const tFill = { up: null, dn: null };
  let ricomprato = null;            // { lato, prezzo, shares, t }
  let uscitaFatta = false;
  let filtro = null, motivoFiltro = "";
  let sbilanciato = null;

  while (Math.floor(Date.now() / 1000) - inizio < WINDOW) {
    const t = (Date.now() - inizio * 1000) / 1000;
    const [up, dn] = await Promise.all([reader.leggi(r.upToken), reader.leggi(r.dnToken)]);
    if (!up || !dn) { await sleep(CFG.POLL_MS); continue; }

    tickRighe.push([r.slug, +t.toFixed(1), up.bestAsk ?? "", up.askSize ?? 0,
      dn.bestAsk ?? "", dn.askSize ?? 0, up.bestBid ?? "", dn.bestBid ?? ""].join(","));

    // ── FILTRO: ai primi secondi, sbilanciamento
    if (filtro === null && t >= CFG.FILTRO_DOPO_S && up.bestAsk && dn.bestAsk) {
      const alto = Math.max(up.bestAsk, dn.bestAsk);
      const basso = Math.min(up.bestAsk, dn.bestAsk);
      sbilanciato = (alto >= CFG.FILTRO_ALTO && basso <= CFG.FILTRO_BASSO);
      filtro = !sbilanciato;
      motivoFiltro = sbilanciato
        ? `sbilanciato: up ${up.bestAsk} dn ${dn.bestAsk}`
        : `ok: up ${up.bestAsk} dn ${dn.bestAsk}`;
      log(sbilanciato ? `    ✋ FILTRO: ${motivoFiltro} → non entra` : `    ✓ filtro: ${motivoFiltro} → si entra`);
    }
    if (filtro === false) {
      if (Math.floor(Date.now() / 1000) - inizio >= WINDOW - 1) break;
      await sleep(CFG.POLL_MS); continue;
    }

    // ── ENTRATA: entrambi i lati a 0,46, una volta ciascuno
    for (const lato of ["up", "dn"]) {
      if (comprato[lato]) continue;
      const b = lato === "up" ? up : dn;
      if (b.bestAsk === null || b.bestAsk > CFG.QUOTA || b.bestAsk < CFG.PREZZO_MIN_FILL) continue;
      if (b.askSize < CFG.SHARES) continue;
      comprato[lato] = true; tFill[lato] = +t.toFixed(1);
      ordine(+t.toFixed(1), lato, "ENTRATA", b.bestAsk, CFG.SHARES, "primo lotto");
    }

    // ── RICOMPRA: il PRIMO lato che tocca 0,90
    if (!ricomprato) {
      for (const lato of ["up", "dn"]) {
        const b = lato === "up" ? up : dn;
        if (b.bestBid !== null && b.bestBid >= CFG.RICOMPRA_A && b.askSize >= CFG.RICOMPRA) {
          ricomprato = { lato, prezzo: r3(b.bestAsk ?? CFG.RICOMPRA_A), shares: CFG.RICOMPRA, t: +t.toFixed(1), chiuso: false };
          ordine(+t.toFixed(1), lato, "RICOMPRA", ricomprato.prezzo, CFG.RICOMPRA, `tocco ${CFG.RICOMPRA_A}`);
          log(`    ↑ ${lato} tocca ${CFG.RICOMPRA_A} → ricomprato`);
          break;
        }
      }
    }

    // ── USCITA del lato ricomprato: se riscende sotto 0,80
    if (ricomprato && !ricomprato.chiuso) {
      const b = ricomprato.lato === "up" ? up : dn;
      if (b.bestBid !== null && b.bestBid < CFG.VENDI_SOTTO) {
        ricomprato.chiuso = true;
        ordine(+t.toFixed(1), ricomprato.lato, "VENDITA_RICOMPRA", b.bestBid, ricomprato.shares, `sotto ${CFG.VENDI_SOTTO}`);
      }
    }

    // ── USCITA 0,40 sul lato perdente scoperto (dopo 60 s)
    if (!uscitaFatta) {
      const latiPosseduti = ["up", "dn"].filter(l => comprato[l] && !(ricomprato && ricomprato.lato === l));
      if (latiPosseduti.length === 1) {
        const lato = latiPosseduti[0];
        const b = lato === "up" ? up : dn;
        const t0 = tFill[lato];
        if (b.bestBid !== null && t0 !== null && (t - t0) >= CFG.USCITA_MIN_S && b.bestBid <= CFG.USCITA) {
          uscitaFatta = true;
          ordine(+t.toFixed(1), lato, "USCITA040", b.bestBid, CFG.SHARES, `${CFG.USCITA_MIN_S}s passati`);
        }
      }
    }

    await sleep(CFG.POLL_MS);
  }
  reader.stop();

  // ── ESITO: letto da Gamma, e riprovato piu' volte
  let esito = null;
  for (let k = 1; k <= 4 && !esito; k++) {
    const e = await leggiEsito(r.slug);
    if (e.stato === "LETTO") esito = e;
    else { log(`    … esito non ancora leggibile (${e.stato}), tentativo ${k}/4`); await sleep(8000); }
  }
  const stato = esito ? "LETTO" : (await leggiEsito(r.slug)).stato ?? "PENDENTE";
  log(esito ? `    ✔ ESITO: ${esito.lato} (prices ${esito.prezzi})` : `    ⚠️ ESITO NON LETTO (${stato}) → round PENDENTE`);

  // ── SCRITTURA DEI FATTI
  append("ordini.csv", "slug,t,lato,tipo,prezzo,shares,valore,nota", ORDINI);
  append("tick.csv", "slug,t,up_ask,up_size,dn_ask,dn_size,up_bid,dn_bid", tickRighe);
  append("esiti.csv", "slug,esito_letto,prezzi_gamma,outcomes,fonte,stato",
    [[r.slug, esito ? esito.lato : "", esito ? esito.prezzi : "", esito ? esito.outcomes : "",
      "gamma", esito ? "LETTO" : "PENDENTE"].join(",")]);
  append("round.csv", "slug,ora_inizio,ora_fine,filtro,motivo_filtro,lati_comprati,ricompra,uscita040,esito_stato",
    [[r.slug, inizio, inizio + WINDOW, filtro === null ? "non_valutato" : (filtro ? "passato" : "bloccato"),
      `"${motivoFiltro}"`, `${comprato.up ? "up" : ""}${comprato.up && comprato.dn ? "+" : ""}${comprato.dn ? "dn" : ""}`,
      ricomprato ? `${ricomprato.lato}@${ricomprato.prezzo}` : "no",
      uscitaFatta ? "si" : "no", esito ? "LETTO" : "PENDENTE"].join(",")]);

  return esito ? esito.lato : null;
}

async function main() {
  log("═══════════════════════════════════════════════");
  log("  xreal v6.0 · SOLO FATTI, niente conti");
  log("  entrambi a 0,48 · ricompra a 0,90 · vende sotto 0,70 · uscita 0,40");
  log("═══════════════════════════════════════════════");
  try {
    fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CFG.OUT_DIR, "README.txt"),
      "Questo run raccoglie SOLO FATTI. Nessun PNL, nessun saldo, nessuna somma.\n" +
      "Per calcolare il PNL: somma gli acquisti (ENTRATA, RICOMPRA) come uscite di cassa,\n" +
      "somma le vendite (VENDITA_RICOMPRA, USCITA040) come entrate,\n" +
      "e a fine round: ogni posizione ancora in mano vale 5 $ se il suo lato\n" +
      "e' quello vincente in esiti.csv, 0 altrimenti.\n" +
      "Se un round ha stato PENDENTE in esiti.csv, NON entra nel conteggio.\n");
  } catch (_) {}

  let fatti = 0, tentativi = 0;
  while (fatti < CFG.MAX_ROUNDS && tentativi < CFG.MAX_ROUNDS * 4) {
    tentativi++;
    const start = roundStart();
    const r = await trovaRound(start);
    if (!r || !r.upToken || !r.dnToken) { log(`[wait] round ${start} non trovato`); await sleep(15000); continue; }
    try { await eseguiRound(r); } catch (e) { log("[err]", e.message); }
    fatti++;
    await sleep(Math.max(1000, (start + WINDOW) * 1000 - Date.now() + 2000));
  }
  log(`\n[exit] ${fatti} round raccolti — solo fatti, il conto si fa fuori`);
  process.exit(0);
}

process.on("SIGINT", () => { log("[stop] uscita"); process.exit(0); });
process.on("SIGTERM", () => { process.exit(0); });
main().catch((e) => { console.error(e); process.exit(1); });
