// ═══════════════════════════════════════════════════════════════════════════
// xmaker.js — bot MAKER paper trading, BTC su/giù 5 minuti Polymarket · v2
//
// NOVITA' v2:
//   1. PNL PER ROUND CORRETTO: ogni movimento di cassa e' legato allo slug del
//      suo round. Il PNL di un round = somma dei SUOI flussi, non piu'
//      "contante adesso - contante a inizio round" (che includeva gli acquisti
//      del round successivo).
//   2. TETTO SUL SECONDO LATO: dopo il primo fill a prezzo P, l'altro lato non
//      viene MAI quotato sopra 1 - P - MARGINE. Ogni coppia completata e'
//      quindi in profitto di almeno MARGINE per share. Se il tetto scende
//      sotto il prezzo minimo, il secondo ordine non viene piazzato.
//   3. STATISTICHE COPPIE / GAMBE SINGOLE: ogni round e' classificato
//      COPPIA (entrambi i lati), GAMBA_SINGOLA (un lato solo), NESSUN_FILL.
//      Il riepilogo mostra quante sono e quanto rende ciascun tipo.
//   4. corretto "tenuti undefined".
//
// ATTENZIONE: i fill restano OTTIMISTICI. Un ordine si considera riempito
// appena l'ask tocca il tuo prezzo, come se fossi primo in coda. Nella realta'
// i fill saranno meno. Fee maker = 0 (corretto per Polymarket).
// ═══════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";

const CFG = {
  CAPITALE: 50,
  SIZE: Number(process.env.SIZE || 5),
  OFFSET_INI: 0.035,
  OFFSET_MIN: 0.01,
  OFFSET_PASSI: 0.005,
  REQUOTE_TOL: 0.02,
  MIN_RESTING_S: 5,
  PREZZO_MIN: 0.05,
  PREZZO_MAX: 0.95,
  MARGINE: Number(process.env.MARGINE || 0.02),   // profitto minimo per share su una coppia
  DIFESA: process.env.DIFESA !== "0",
  STOP_TENUTO: Number(process.env.STOP || 0.35),
  STOP_DOPO_S: 30,
  ROUNDS: Number(process.env.ROUNDS || 10),
  POLL_MS: 1000,
  CAMPIONE_S: 60,
  ESITO_DOPO_S: 90,
  ESITO_OGNI_S: 10,
  ESITO_MAX_S: 900,
  OUT_DIR: process.env.OUT_DIR || "out-mk",
};
const WINDOW = 300;

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

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

// ─── portafoglio: ogni flusso di cassa e' legato al suo round ───────────────
const PF = { contante: CFG.CAPITALE, posizioni: [], flussi: new Map() };
function muovi(slug, importo) {
  PF.contante = r4(PF.contante + importo);
  PF.flussi.set(slug, r4((PF.flussi.get(slug) || 0) + importo));
}
function ordine(o) {
  csv("ordini.csv", "slug,t,lato,azione,prezzo,size,importo,secondi_in_book,contante_dopo",
    [[o.slug, o.t, o.lato, o.azione, r4(o.prezzo), o.size, r4(o.importo), o.resting ?? "", PF.contante]]);
  log(`   ${o.azione.padEnd(13)} ${o.lato} ${o.size}@${r4(o.prezzo)}${o.resting != null ? ` (in book ${o.resting}s)` : ""} = ${o.importo >= 0 ? "+" : ""}${r4(o.importo)} $ | contante ${r2(PF.contante)}`);
}
function riempi(slug, t, lato, prezzo, size) {
  const costo = r4(prezzo * size);
  if (costo > PF.contante + 1e-9) { log(`   RIFIUTATO ${lato}: contante ${r2(PF.contante)} < ${costo}`); return null; }
  muovi(slug, -costo);
  const p = { slug, lato, prezzo, size, t };
  PF.posizioni.push(p);
  ordine({ slug, t, lato, azione: "FILL_MAKER", prezzo, size, importo: -costo });
  return p;
}
function vendi(p, prezzo, t, azione) {
  const inc = r4(prezzo * p.size);
  muovi(p.slug, inc);
  PF.posizioni.splice(PF.posizioni.indexOf(p), 1);
  ordine({ slug: p.slug, t, lato: p.lato, azione, prezzo, size: p.size, importo: inc, resting: r4(t - p.t) });
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
  const minSize = Number(m.rewardsMinSize ?? m.rewards_min_size ?? ev[0].rewardsMinSize ?? 0) || 0;
  const maxSpreadC = Number(m.rewardsMaxSpread ?? m.rewards_max_spread ?? ev[0].rewardsMaxSpread ?? 3) || 3;
  const cfg = m.rewardsConfig ?? m.rewards_config ?? ev[0].rewardsConfig ?? null;
  const ratePerDay = cfg ? (Array.isArray(cfg) ? cfg.reduce((s, c) => s + Number(c.rate_per_day ?? c.ratePerDay ?? 0), 0) : Number(cfg.rate_per_day ?? 0)) : 0;
  return { slug, start, up: tok[iUp], dn: tok[1 - iUp], minSize, maxSpread: maxSpreadC / 100, ratePerDay };
}
async function book(token) {
  try {
    const b = await jget(`${CLOB}/book?token_id=${token}`);
    const lv = (a) => (a || []).map((x) => [parseFloat(x.price), parseFloat(x.size)]).filter((x) => x[1] > 0 && isFinite(x[0]));
    const asks = lv(b.asks).sort((a, c) => a[0] - c[0]);
    const bids = lv(b.bids).sort((a, c) => c[0] - a[0]);
    return { ask: asks[0]?.[0] ?? null, askSz: asks[0]?.[1] ?? 0, bid: bids[0]?.[0] ?? null, bidSz: bids[0]?.[1] ?? 0 };
  } catch (_) { return null; }
}

// ─── esito da Gamma, differito ─────────────────────────────────────────────
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
const HEAD_ROUND = "slug,esito,tipo,lati_fill,costo_coppia,fill_maker,tenuti,stop,size_ordine,resting_medio_s,pnl,secondi_esito";
async function risolvi() {
  for (const s of [...SOSPESI]) {
    const eta = nowS() - s.fine;
    if (eta < CFG.ESITO_DOPO_S || nowS() - s.ultimoTentativo < CFG.ESITO_OGNI_S) continue;
    s.ultimoTentativo = nowS();
    let e = null, errore = null;
    try { e = await esitoGamma(s.r.slug); } catch (err) { errore = err.message; }
    if (!e) {
      if (eta > CFG.ESITO_MAX_S) {
        SOSPESI.splice(SOSPESI.indexOf(s), 1);
        csv("esiti.csv", "slug,esito,prezzi,secondi_dopo_fine", [[s.r.slug, "NON_RISOLTO", errore || "", Math.round(eta)]]);
        csv("round.csv", HEAD_ROUND, [[s.r.slug, "NON_RISOLTO", s.tipo, s.lati, s.costoCoppia, s.nFill, s.nTenuti, s.stop, CFG.SIZE, s.restingMedio, "", Math.round(eta)]]);
        log(`NON RISOLTO ${s.r.slug} dopo ${Math.round(eta)} s — escluso dal PNL (posizioni ferme al costo)`);
      }
      continue;
    }
    for (const p of [...PF.posizioni.filter((x) => x.slug === s.r.slug)])
      vendi(p, p.lato === e.lato ? 1 : 0, 300, p.lato === e.lato ? "SCADENZA_VINTA" : "SCADENZA_PERSA");
    const pnl = r4(PF.flussi.get(s.r.slug) || 0);   // solo i flussi di QUESTO round
    SOSPESI.splice(SOSPESI.indexOf(s), 1);
    csv("esiti.csv", "slug,esito,prezzi,secondi_dopo_fine", [[s.r.slug, e.lato, e.prezzi, Math.round(eta)]]);
    csv("round.csv", HEAD_ROUND, [[s.r.slug, e.lato, s.tipo, s.lati, s.costoCoppia, s.nFill, s.nTenuti, s.stop, CFG.SIZE, s.restingMedio, pnl, Math.round(eta)]]);
    log(`ESITO ${s.r.slug}: ${e.lato} (Gamma ${e.prezzi}, +${Math.round(eta)}s) | ${s.tipo} ${s.lati || ""} | fill ${s.nFill} tenuti ${s.nTenuti} stop ${s.stop} | PNL ${pnl >= 0 ? "+" : ""}${pnl}`);
  }
}

// ─── un round ──────────────────────────────────────────────────────────────
async function round(r) {
  log(`\n══════ ROUND ${r.slug} (${new Date(r.start * 1000).toISOString().slice(11, 19)} UTC)`);
  log(`   size ${CFG.SIZE} · margine coppia ${CFG.MARGINE} · minSize reward ${r.minSize} · reward/giorno ${r.ratePerDay}`);
  const tick = [];
  const ap = { up: null, dn: null };
  const posRound = [];
  const fillLati = {};            // lato -> prezzo del fill (anche se poi stoppato)
  let tetto = null;               // prezzo massimo per il secondo lato
  const offset = CFG.OFFSET_INI;
  let nFill = 0, stop = 0;
  let sResting = 0, nResting = 0, ultimoLog = -999;

  const annulla = (l, t) => {
    const o = ap[l];
    ordine({ slug: r.slug, t, lato: l, azione: "ANNULLA", prezzo: o.prezzo, size: o.size, importo: 0, resting: r4(t - o.t) });
    sResting += r4(t - o.t); nResting++;
    ap[l] = null;
  };

  while (nowS() - r.start < WINDOW - 0.5) {
    const t = r4(nowS() - r.start);
    const [up, dn] = await Promise.all([book(r.up), book(r.dn)]);
    if (up && dn && up.bid !== null && dn.bid !== null && up.ask !== null && dn.ask !== null) {
      tick.push([t.toFixed(1), up.ask, Math.round(up.askSz), dn.ask, Math.round(dn.askSz), up.bid, dn.bid]);
      const bk = { up, dn };
      const mid = { up: r4((up.bid + up.ask) / 2), dn: r4((dn.bid + dn.ask) / 2) };

      // ── fill PRIMA della quotazione: un ask che scende sul tuo ordine lo colpisce
      //    prima che tu possa spostarlo (ottimistico: sei primo in coda)
      for (const l of ["up", "dn"]) {
        const o = ap[l], b = bk[l];
        if (!o) continue;
        if (b.ask !== null && b.ask <= o.prezzo) {
          const prezzo = o.prezzo, size = o.size;
          annulla(l, t);
          const p = riempi(r.slug, t, l, prezzo, size);
          if (p) {
            nFill++; posRound.push(p); fillLati[l] = prezzo;
            if (Object.keys(fillLati).length === 1) {
              tetto = r4(1 - prezzo - CFG.MARGINE);
              log(`   TETTO secondo lato: ${tetto} (1 - ${prezzo} - ${CFG.MARGINE})`);
            }
          }
        }
      }

      // ── quotazione
      for (const l of ["up", "dn"]) {
        if (fillLati[l] !== undefined) continue;          // lato gia' comprato in questo round
        const b = bk[l];
        let desiderato = Math.max(CFG.PREZZO_MIN,
          Math.min(CFG.PREZZO_MAX, r4(Math.min(r4(mid[l] - offset), r4(b.ask - 0.01)))));
        if (tetto !== null) desiderato = Math.min(desiderato, tetto);
        const vecchio = ap[l];

        // tetto sotto il prezzo minimo: niente secondo ordine
        if (tetto !== null && tetto < CFG.PREZZO_MIN) { if (vecchio) annulla(l, t); continue; }

        if (vecchio) {
          const sopraTetto = tetto !== null && vecchio.prezzo > tetto + 1e-9;   // va tolto subito
          if (!sopraTetto) {
            if (t - vecchio.t < CFG.MIN_RESTING_S) continue;
            if (Math.abs(vecchio.prezzo - desiderato) < CFG.REQUOTE_TOL) continue;
          }
          annulla(l, t);
        }
        ap[l] = { prezzo: desiderato, size: CFG.SIZE, t };
        ordine({ slug: r.slug, t, lato: l, azione: "PIAZZA_LIMITE", prezzo: desiderato, size: CFG.SIZE, importo: 0,
                 resting: null });
      }

      // ── difesa (stop sul lato singolo)
      if (CFG.DIFESA && Object.keys(fillLati).length === 1) for (const p of [...posRound]) {
        const b = bk[p.lato];
        if (b.bid !== null && t - p.t >= CFG.STOP_DOPO_S && b.bid <= CFG.STOP_TENUTO && b.bidSz >= p.size) {
          vendi(p, b.bid, t, "STOP");
          stop++;
          posRound.splice(posRound.indexOf(p), 1);
          for (const l of ["up", "dn"]) if (ap[l]) annulla(l, t);   // round chiuso per la difesa
          fillLati.stop = true;
        }
      }
      if (fillLati.stop) { await sleep(CFG.POLL_MS); continue; }

      if (t - ultimoLog >= CFG.CAMPIONE_S) {
        ultimoLog = t;
        log(`   [${Math.round(t)}s] mid up ${mid.up}/dn ${mid.dn} · ordini ${ap.up ? ap.up.prezzo : "-"}/${ap.dn ? ap.dn.prezzo : "-"} · tetto ${tetto ?? "-"} · fill ${nFill} · contante ${r2(PF.contante)}`);
      }
    }
    await risolvi();
    await sleep(CFG.POLL_MS);
  }

  const tFine = r4(nowS() - r.start);
  for (const l of ["up", "dn"]) if (ap[l]) annulla(l, tFine);

  fs.writeFileSync(path.join(CFG.OUT_DIR, "tick", `${r.slug}.csv`),
    "t,up_ask,up_size,dn_ask,dn_size,up_bid,dn_bid\n" + tick.map((x) => x.join(",")).join("\n") + "\n");

  const lati = ["up", "dn"].filter((l) => fillLati[l] !== undefined);
  const tipo = lati.length === 2 ? "COPPIA" : lati.length === 1 ? "GAMBA_SINGOLA" : "NESSUN_FILL";
  const costoCoppia = lati.length === 2 ? r4(fillLati.up + fillLati.dn) : "";
  const latiTxt = lati.map((l) => `${l}@${fillLati[l]}`).join("+");
  log(`   fine round · ${tipo} ${latiTxt}${costoCoppia !== "" ? ` (somma ${costoCoppia}, bloccato ${r4(CFG.SIZE * (1 - costoCoppia))} $)` : ""} · stop ${stop} · in book medio ${nResting ? r2(sResting / nResting) : 0}s → esito tra ${CFG.ESITO_DOPO_S}s`);
  SOSPESI.push({ r, fine: r.start + WINDOW, ultimoTentativo: 0, tipo, lati: latiTxt, costoCoppia,
    nFill, nTenuti: posRound.length, stop, restingMedio: nResting ? r4(sResting / nResting) : "" });
}

// ─── riepilogo con quadratura ──────────────────────────────────────────────
function riepilogo() {
  const f = path.join(CFG.OUT_DIR, "round.csv");
  const righe = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")) : [];
  const ok = righe.filter((x) => x[1] === "up" || x[1] === "dn");
  const n = ok.length || 1;
  const pnl = r4(ok.reduce((s, x) => s + Number(x[10]), 0));
  const perTipo = {};
  for (const x of ok) {
    const k = x[2];
    perTipo[k] = perTipo[k] ?? { n: 0, pnl: 0, vinte: 0 };
    perTipo[k].n++; perTipo[k].pnl = r4(perTipo[k].pnl + Number(x[10]));
    if (Number(x[10]) > 0) perTipo[k].vinte++;
  }
  const riga = (k) => { const v = perTipo[k] ?? { n: 0, pnl: 0, vinte: 0 };
    return `${k.padEnd(14)} ${String(v.n).padStart(4)} round (${r2(100 * v.n / n)}%) · PNL ${v.pnl} · medio ${v.n ? r4(v.pnl / v.n) : 0} · in profitto ${v.vinte}`; };
  const fermi = r4(PF.posizioni.reduce((s, p) => s + p.prezzo * p.size, 0));
  const saldo = r4(PF.contante + fermi);
  const atteso = r4(CFG.CAPITALE + pnl);
  const txt = [
    "bot maker 5m BTC v2 (paper, fill ottimistici, senza reward)",
    "capitale " + CFG.CAPITALE,
    "size_ordine " + CFG.SIZE,
    "margine_coppia " + CFG.MARGINE,
    "difesa " + (CFG.DIFESA ? `attiva (stop ${CFG.STOP_TENUTO})` : "spenta"),
    "round_risolti " + ok.length,
    "round_non_risolti " + (righe.length - ok.length + SOSPESI.length),
    riga("COPPIA"),
    riga("GAMBA_SINGOLA"),
    riga("NESSUN_FILL"),
    "pnl " + pnl + "  (per round " + r4(pnl / n) + ")",
    "contante " + PF.contante,
    "posizioni_aperte_al_costo " + fermi,
    "saldo " + saldo,
    "atteso " + atteso,
    "quadratura " + (Math.abs(atteso - saldo) < 0.005 ? "OK" : "FALLITA"),
    ""
  ].join("\n");
  fs.writeFileSync(path.join(CFG.OUT_DIR, "riepilogo.txt"), txt);
  log("\n══════ RIEPILOGO\n" + txt);
}

async function main() {
  log(`══ xmaker v2 · ${CFG.ROUNDS} round · capitale ${CFG.CAPITALE} · size ${CFG.SIZE} · margine ${CFG.MARGINE} · difesa ${CFG.DIFESA ? "attiva" : "spenta"}`);
  let fatti = 0;
  while (fatti < CFG.ROUNDS) {
    const prossimo = Math.ceil(nowS() / WINDOW) * WINDOW;
    log(`[attesa] prossimo round alle ${new Date(prossimo * 1000).toISOString().slice(11, 19)} UTC`);
    while (nowS() < prossimo - 0.2) {
      await risolvi();
      await sleep(Math.min(5000, Math.max(200, (prossimo - nowS()) * 1000 - 200)));
    }
    let r = null;
    for (let k = 0; k < 5 && !r; k++) {
      try { r = await trovaRound(prossimo); } catch (e) { log("[warn] gamma:", e.message); }
      if (!r) await sleep(1000);
    }
    if (!r) { log(`[salto] round ${prossimo} non trovato`); continue; }
    try { await round(r); fatti++; } catch (e) { log("[err] round:", e.stack || e.message); }
  }
  log(`[fine] attendo gli esiti di ${SOSPESI.length} round...`);
  while (SOSPESI.length) { await risolvi(); await sleep(2000); }
  riepilogo();
  process.exit(0);
}
process.on("SIGINT", () => { log("\n[interrotto]"); riepilogo(); process.exit(0); });
process.on("SIGTERM", () => { log("\n[interrotto]"); riepilogo(); process.exit(0); });
if (!process.env.XMAKER_NO_MAIN) main().catch((e) => { log("[fatale]", e.stack || e.message); process.exit(1); });
export { CFG, PF, riempi, vendi, round, risolvi, riepilogo, SOSPESI };
