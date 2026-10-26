// ═══════════════════════════════════════════════════════════════════════════
// xfair.js — PAPER TRADING · maker con PREZZO GIUSTO da BTC (Chainlink)
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

const CFG = {
  CAPITALE: 50,
  SIZE: Number(process.env.SIZE || 5),
  MAX_SHARES: Number(process.env.MAX_SHARES || 10),   // per lato per round
  EDGE: Number(process.env.EDGE || 0.05),              // sconto minimo sul prezzo giusto
  REQUOTE_TOL: 0.01,
  PREZZO_MIN: 0.05,
  PREZZO_MAX: 0.95,
  STOP_QUOTE_S: Number(process.env.STOP_QUOTE_S || 60), // niente ordini negli ultimi N s
  TWAP_S: 30,
  VOL_FINESTRA_S: 600,
  VOL_DEFAULT: 7e-5,        // σ per √secondo (≈ 0,12% su 5 minuti)
  VOL_MIN: 2e-5,
  FEED_MAX_RITARDO_S: 5,
  LATENZA_S: Number(process.env.LATENZA_S || 2),     // ritardo stimato del bot (polling 1 s + rete)
  K_SALTO: Number(process.env.K_SALTO || 3),          // edge extra = K_SALTO × salto possibile in LATENZA_S
  ROUNDS: Number(process.env.ROUNDS || 10),
  POLL_MS: 1000,
  CAMPIONE_S: 30,
  ESITO_DOPO_S: 90,
  ESITO_OGNI_S: 10,
  ESITO_MAX_S: 900,
  OUT_DIR: process.env.OUT_DIR || "out-fair",
  RTDS: "wss://ws-live-data.polymarket.com",
};
const WINDOW = 300;
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

// ─── FEED PREZZO BTC (Chainlink via RTDS di Polymarket) ────────────────────
class Feed {
  constructor() { this.tick = []; this.ws = null; this.grezzi = 0; this.chiuso = false; }
  push(ts, prezzo) {                       // ts in secondi
    if (!isFinite(ts) || !isFinite(prezzo) || prezzo <= 0) return;
    const ultimo = this.tick[this.tick.length - 1];
    if (ultimo && ts <= ultimo[0]) return;
    this.tick.push([ts, prezzo]);
    const limite = ts - 2 * CFG.VOL_FINESTRA_S;
    while (this.tick.length && this.tick[0][0] < limite) this.tick.shift();
  }
  ultimo() { return this.tick[this.tick.length - 1] ?? null; }
  primoDopo(ts) { return this.tick.find((x) => x[0] >= ts) ?? null; }
  media(da, a) {                           // media temporale del prezzo tra da e a
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
  start() {
    if (this.chiuso) return;
    let WS;
    import("ws").then((m) => {
      WS = m.default;
      this.ws = new WS(CFG.RTDS);
      this.ws.on("open", () => {
        this.ws.send(JSON.stringify({ action: "subscribe", subscriptions: [
          { topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol: "btc/usd" }) },
        ] }));
        log("[feed] connesso a RTDS, sottoscritto crypto_prices_chainlink btc/usd");
        this.ping = setInterval(() => { try { this.ws.send("PING"); } catch (_) {} }, 5000);
      });
      this.ws.on("message", (raw) => {
        const s = raw.toString();
        if (this.grezzi < 3) { this.grezzi++; log(`[feed] messaggio grezzo #${this.grezzi}: ${s.slice(0, 300)}`); }
        let m; try { m = JSON.parse(s); } catch (_) { return; }
        const p = m?.payload; if (!p) return;
        if (p.symbol && String(p.symbol).toLowerCase() !== "btc/usd") return;
        const conv = (ts) => (ts > 1e12 ? ts / 1000 : ts);
        if (Array.isArray(p.data)) for (const d of p.data) this.push(conv(Number(d.timestamp)), Number(d.value));
        else if (p.value !== undefined) this.push(conv(Number(p.timestamp ?? m.timestamp)), Number(p.value));
      });
      this.ws.on("close", () => { clearInterval(this.ping); if (!this.chiuso) { log("[feed] chiuso, riconnessione"); setTimeout(() => this.start(), 2000); } });
      this.ws.on("error", (e) => log("[feed] errore:", e.message));
    }).catch((e) => log("[feed] modulo ws mancante:", e.message));
  }
}
const FEED = new Feed();

// prezzo giusto di UP, dato il prezzo di inizio round
function prezzoGiusto(r, t) {
  const u = FEED.ultimo();
  if (!u || nowS() - u[0] > CFG.FEED_MAX_RITARDO_S || !r.prezzoInizio) return null;
  const sigma = FEED.vol();
  const tau = Math.max(0, WINDOW - t);           // secondi alla fine
  const W = CFG.TWAP_S;
  let atteso, varianza;
  if (tau >= W) {
    // la media degli ultimi W s parte nel futuro: varianza = σ²(τ - W + W/3)
    atteso = u[1];
    varianza = sigma ** 2 * (tau - W + W / 3) * u[1] ** 2;
  } else {
    // parte della media e' gia' osservata
    const fatto = W - tau;
    const mediaFatta = FEED.media(r.start + WINDOW - W, nowS()) ?? u[1];
    atteso = (mediaFatta * fatto + u[1] * tau) / W;
    varianza = sigma ** 2 * (tau ** 3) / (3 * W * W) * u[1] ** 2;
  }
  const diff = atteso - r.prezzoInizio;
  if (varianza <= 0) return diff >= 0 ? 0.999 : 0.001;
  const z = diff / Math.sqrt(varianza);
  // quanto puo' muoversi il prezzo giusto in LATENZA_S secondi (1 deviazione standard):
  // serve ad allargare l'edge quando un ordine rischia di restare indietro
  const quotaFutura = tau >= W ? 1 : tau / W;
  const dS = u[1] * sigma * Math.sqrt(CFG.LATENZA_S) * quotaFutura;
  const densita = 0.3989422804014327 * Math.exp(-z * z / 2);
  prezzoGiusto.salto = Math.min(0.5, densita * dS / Math.sqrt(varianza));
  return Math.min(0.999, Math.max(0.001, phi(z)));
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
  const slug = `btc-updown-5m-${start}`;
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
const HEAD_ROUND = "slug,esito,prezzo_inizio,fill_up,fill_dn,costo,edge_medio,pnl,brier_modello,brier_mercato,campioni";
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
        csv("round.csv", HEAD_ROUND, [[s.r.slug, "NON_RISOLTO", s.r.prezzoInizio ?? "", s.fillUp, s.fillDn, s.costo, s.edgeMedio, "", "", "", ""]]);
        log(`NON RISOLTO ${s.r.slug} — escluso dal PNL`);
      }
      continue;
    }
    for (const p of [...PF.posizioni.filter((x) => x.slug === s.r.slug)]) {
      const inc = p.lato === e.lato ? p.size : 0;
      muovi(p.slug, inc);
      PF.posizioni.splice(PF.posizioni.indexOf(p), 1);
      ordine({ slug: p.slug, t: 300, lato: p.lato, azione: p.lato === e.lato ? "SCADENZA_VINTA" : "SCADENZA_PERSA", prezzo: inc ? 1 : 0, size: p.size, importo: inc });
    }
    const pnl = r4(PF.flussi.get(s.r.slug) || 0);
    const y = e.lato === "up" ? 1 : 0;
    const bm = s.campioni.length ? r4(s.campioni.reduce((a, c) => a + (c.giusto - y) ** 2, 0) / s.campioni.length) : "";
    const bk = s.campioni.length ? r4(s.campioni.reduce((a, c) => a + (c.mid - y) ** 2, 0) / s.campioni.length) : "";
    csv("calibrazione.csv", "slug,t,giusto_up,mid_up,esito_up", s.campioni.map((c) => [s.r.slug, c.t, c.giusto, c.mid, y]));
    SOSPESI.splice(SOSPESI.indexOf(s), 1);
    csv("round.csv", HEAD_ROUND, [[s.r.slug, e.lato, s.r.prezzoInizio ?? "", s.fillUp, s.fillDn, s.costo, s.edgeMedio, pnl, bm, bk, s.campioni.length]]);
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
      if (p0 && p0[0] - r.start < 10) { r.prezzoInizio = p0[1]; log(`   prezzo di inizio (Chainlink) ${p0[1]} a +${r4(p0[0] - r.start)}s`); }
      else if (t > 10) { log(`   ⚠ nessun prezzo di inizio entro 10 s: round saltato`); break; }
    }
    const [up, dn] = await Promise.all([book(r.up), book(r.dn)]);
    const gUp = prezzoGiusto(r, t);
    if (up && dn) tick.push([t.toFixed(1), gUp ?? "", up.bid ?? "", up.ask ?? "", dn.bid ?? "", dn.ask ?? "", FEED.ultimo()?.[1] ?? ""]);

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
        campioni.push({ t: Math.round(t), giusto: r4(gUp), mid: r4((up.bid + up.ask) / 2) });
      }
      if (t - ultimoLog >= 60) {
        ultimoLog = t;
        log(`   [${Math.round(t)}s] BTC ${FEED.ultimo()?.[1]} (inizio ${r.prezzoInizio}) σ ${FEED.vol().toExponential(2)} · giusto up ${r4(gUp)} · book up ${up.bid}/${up.ask} dn ${dn.bid}/${dn.ask} · ordini ${ap.up?.prezzo ?? "-"}/${ap.dn?.prezzo ?? "-"} · preso up ${preso.up} dn ${preso.dn}`);
      }
    }
    await risolvi();
    await sleep(CFG.POLL_MS);
  }
  annulla("up", r4(nowS() - r.start)); annulla("dn", r4(nowS() - r.start));
  fs.writeFileSync(path.join(CFG.OUT_DIR, "tick", `${r.slug}.csv`),
    "t,giusto_up,up_bid,up_ask,dn_bid,dn_ask,btc\n" + tick.map((x) => x.join(",")).join("\n") + "\n");
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
  const cal = fs.existsSync(fc) ? fs.readFileSync(fc, "utf8").trim().split("\n").slice(1).map((l) => l.split(",").map((v, i) => (i ? Number(v) : v))) : [];
  const brier = (k) => cal.length ? r4(cal.reduce((a, c) => a + (c[k] - c[4]) ** 2, 0) / cal.length) : "-";
  const fasce = [];
  for (let i = 0; i < 10; i++) {
    const c = cal.filter((x) => x[2] >= i / 10 && x[2] < (i + 1) / 10 + (i === 9 ? 1e-9 : 0));
    if (c.length) fasce.push(`  giusto ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}: ${String(c.length).padStart(4)} campioni · UP vinto ${r2(100 * c.reduce((a, x) => a + x[4], 0) / c.length)}%`);
  }
  const fermi = r4(PF.posizioni.reduce((s, p) => s + p.prezzo * p.size, 0));
  const saldo = r4(PF.contante + fermi), atteso = r4(CFG.CAPITALE + pnl);
  const txt = [
    "xfair · maker con prezzo giusto da Chainlink (paper, fill ottimistici)",
    `capitale ${CFG.CAPITALE} · size ${CFG.SIZE} · edge ${CFG.EDGE} · max ${CFG.MAX_SHARES}/lato`,
    `round_risolti ${ok.length} (con fill ${conFill.length}) · non_risolti ${righe.length - ok.length + SOSPESI.length}`,
    `pnl ${pnl} · per round ${ok.length ? r4(pnl / ok.length) : 0} · round in profitto ${conFill.filter((x) => Number(x[7]) > 0).length}/${conFill.length}`,
    "",
    `CALIBRAZIONE (${cal.length} campioni) — Brier: piu' basso = previsione migliore`,
    `  modello ${brier(2)}  vs  mercato ${brier(3)}`,
    "  → se il modello non e' piu' basso del mercato, non c'e' vantaggio",
    ...fasce,
    "",
    `contante ${PF.contante} · posizioni aperte al costo ${fermi} · saldo ${saldo} · atteso ${atteso} · quadratura ${Math.abs(atteso - saldo) < 0.005 ? "OK" : "FALLITA"}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(CFG.OUT_DIR, "riepilogo.txt"), txt);
  log("\n══════ RIEPILOGO\n" + txt);
}

async function main() {
  log(`══ xfair · ${CFG.ROUNDS} round · edge ${CFG.EDGE} · size ${CFG.SIZE} · max ${CFG.MAX_SHARES}/lato · stop quote ultimi ${CFG.STOP_QUOTE_S}s`);
  FEED.start();
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
export { CFG, FEED, PF, round, risolvi, riepilogo, SOSPESI, prezzoGiusto, phi };
