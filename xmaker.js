// ═══════════════════════════════════════════════════════════════════════════
// xmaker.js — PAPER TRADING · bot MAKER sulle 5 minuti BTC su/giù di Polymarket
//
// COSA FA
//   1. Ogni round piazza DUE ordini limite passivi (uno per lato: Up e Down).
//      Prezzo: 0,50 − offset, con l'offset calcolato dal book vero in modo che
//      il spread dei due ordini resti dentro il max spread premiato dal mercato
//      (rewards_max_spread, letto dalla Gamma API per quel mercato).
//   2. Gli ordini restano nel book e vengono ripiazzati solo se il midpoint si
//      sposta oltre la tolleranza (REQUOTE_TOL).
//   3. Un ordine si considera riempito quando il best ask scende al suo prezzo
//      o sotto (per il bid), o il best bid sale al suo prezzo o sopra (per l'ask).
//   4. Se dopo il riempimento il lato perde (prezzo al bid sotto STOP_TENUTO),
//      il bot vende: è la difesa contro il "riempimento tossico", il vero
//      rischio del maker. Toggle con DIFESA.
//   5. A fine round le posizioni restanti incassano 1,00 se il lato vince,
//      0 se perde. L'esito si legge SOLO da Gamma, differito (90 s +).
//   6. Ogni 60 s una riga di stato: spread, size piazzate, fill, PNL, e stima
//      della quota di reward (minima, vedi nota in fondo).
//
// WHAT-IF (opzionale): se piazzi il file out-mk/quote-agent.json con un ask a
//   0,01−0,05 su un lato, il bot compra a quel prezzo su quel lato come farebbe
//   un taker: serve a verificare il percorso dei fill simulati. Senza file,
//   niente what-if.
//
// FEE: non applicate. NB: i maker non pagano fee; il rebate maker (20% delle
//   taker fee, categoria Crypto) NON è incluso in questa stima.
//
// ATTENZIONE — questo bot NON piazza ordini veri e NON guadagna reward vere.
// Le reward vere richiedono ordini reali nel book e il bot le stima soltanto.
//
// Uso:   node xmaker.mjs              (10 round)
//        ROUNDS=30 node xmaker.mjs
// Output in out-mk/: ordini.csv, posizioni.csv (una riga di stato per round
//   a ogni campione), round.csv, esiti.csv, reward.csv, riepilogo.txt,
//   tick/<slug>.csv, log.txt
// Node 18+ (fetch nativo). Nessuna dipendenza.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";

const CFG = {
  CAPITALE: 50,
  SIZE: Number(process.env.SIZE || 5), // share per ordine (deve coprire SIZE giù)
  OFFSET_INI: 0.035,     // primo tentativo: 3,5 centesimi dal midpoint
  OFFSET_MIN: 0.01,      // mai meno di 1 centesimo dal midpoint
  OFFSET_PASSI: 0.005,
  REQUOTE_TOL: 0.005,    // ripiazza se il midpoint si muove oltre 0,5 cent
  PREZZO_MIN: 0.05,
  PREZZO_MAX: 0.95,
  // difesa anti fill tossico
  DIFESA: process.env.DIFESA !== "0",
  STOP_TENUTO: Number(process.env.STOP || 0.35),
  STOP_DOPO_S: 30,
  // quota minima di size richiesta dal mercato se la config non si legge
  MIN_SIZE_RIPIEGO: 20,
  // round
  ROUNDS: Number(process.env.ROUNDS || 10),
  POLL_MS: 1000,
  CAMPIONE_S: 60,        // riga di stato / campione per la stima reward
  WHATIF_DOPO_S: 90,
  ESITO_DOPO_S: 90,
  ESITO_OGNI_S: 10,
  ESITO_MAX_S: 900,
  OUT_DIR: process.env.OUT_DIR || "out-mk",
};
const WINDOW = 300;
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

// ─── utilità ───────────────────────────────────────────────────────────────
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

// ─── portafoglio ───────────────────────────────────────────────────────────
const PF = { contante: CFG.CAPITALE, posizioni: [] };
function muovi(slug, importo) { PF.contante = r4(PF.contante + importo); }
function ordine(o) {
  csv("ordini.csv", "slug,t,lato,azione,prezzo,size,importo,contante_dopo",
    [[o.slug, o.t, o.lato, o.azione, r4(o.prezzo), o.size, r4(o.importo), PF.contante]]);
  log(`   ${o.azione.padEnd(12)} ${o.lato} ${o.size}@${r2(o.prezzo)} = ${o.importo >= 0 ? "+" : ""}${r2(o.importo)} $ | contante ${r2(PF.contante)}`);
}
function piazza(slug, t, lato, prezzo, size) {
  ordine({ slug, t, lato, azione: "PIAZZA_LIMITE", prezzo, size, importo: 0 });
}
function annulla(slug, t, lato, prezzo, size) {
  ordine({ slug, t, lato, azione: "ANNULLA", prezzo, size, importo: 0 });
}
function riempi(slug, t, lato, prezzo, size, tipo) {
  const costo = r4(prezzo * size);
  if (costo > PF.contante + 1e-9) { log(`   RIFIUTATO ${lato}: contante ${r2(PF.contante)} < ${costo}`); return false; }
  muovi(slug, -costo);
  const p = { slug, lato, prezzo, size, t, tipo };
  PF.posizioni.push(p);
  ordine({ slug, t, lato, azione: tipo === "MAKER" ? "FILL_MAKER" : "FILL_TAKER", prezzo, size, importo: -costo });
  return true;
}
function vendi(slug, p, prezzo, t, azione) {
  const inc = r4(prezzo * p.size);
  muovi(slug, inc);
  PF.posizioni.splice(PF.posizioni.indexOf(p), 1);
  ordine({ slug, t, lato: p.lato, azione, prezzo, size: p.size, importo: inc });
}

// ─── mercato ───────────────────────────────────────────────────────────────
async function trovaRound(start) {
  const slug = `btc-updown-5m-${start}`;
  const ev = await jget(`${GAMMA}/events?slug=${slug}`);
  const m = ev?.[0]?.markets?.[0];
  if (!m) return null;
  const tok = parse(m.clobTokenIds);
  const oc = parse(m.outcomes).map((s) => String(s).toLowerCase());
  const iUp = oc.findIndex((s) => s.startsWith("up"));
  if (iUp < 0 || !tok?.[0] || !tok?.[1] || !tok?.[iUp] || !tok?.[1 - iUp]) return null;
  // config reward del mercato: può stare sul mercato o sull'evento
  const minSize = Number(m.rewardsMinSize ?? m.rewards_min_size ?? ev[0].rewardsMinSize ?? CFG.MIN_SIZE_RIPIEGO) || CFG.MIN_SIZE_RIPIEGO;
  const maxSpreadC = Number(m.rewardsMaxSpread ?? m.rewards_max_spread ?? ev[0].rewardsMaxSpread ?? 3) || 3;
  const cfg = m.rewardsConfig ?? m.rewards_config ?? ev[0].rewardsConfig ?? null;
  const ratePerDay = cfg ? (Array.isArray(cfg) ? cfg.reduce((s, c) => s + Number(c.rate_per_day ?? c.ratePerDay ?? 0), 0) : Number(cfg.rate_per_day ?? 0)) : 0;
  return { slug, start, up: tok[iUp], dn: tok[1 - iUp], minSize, maxSpread: maxSpreadC / 100, ratePerDay,
           feeBps: Number(m.feeRateBps ?? 0) || 0 };
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
// lettura opzionale del foglio what-if
function whatif(lato) {
  const f = path.join(CFG.OUT_DIR, "quote-agent.json");
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const q = j[lato];
    const p = typeof q === "number" ? q : q?.ask;
    return p > 0 && p <= 0.05 ? p : null;
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
        log(`⚠️  ${s.r.slug} NON RISOLTO dopo ${Math.round(eta)} s — posizioni ferme al costo, fuori dal PNL`);
      }
      continue;
    }
    for (const p of [...PF.posizioni.filter((x) => x.slug === s.r.slug)])
      vendi(s.r.slug, p, p.lato === e.lato ? 1 : 0, 300, p.lato === e.lato ? "SCADENZA_VINTA" : "SCADENZA_PERSA");
    const saldo = PF.contante;
    const pnl = r4(saldo - s.saldoPrima);
    SOSPESI.splice(SOSPESI.indexOf(s), 1);
    csv("esiti.csv", "slug,esito,prezzi,secondi_dopo_fine", [[s.r.slug, e.lato, e.prezzi, Math.round(eta)]]);
    csv("round.csv", "slug,esito,fill_maker,fill_taker,fills_tenuti,stop,size_media_piazzata,spread_medio_c,pnl,rate_per_day,reward_stimata,secondi_esito",
      [[s.r.slug, e.lato, s.nMaker, s.nTaker, s.tenuti, s.stop, r2(s.sizeMedia), s.spreadMedio, pnl, s.r.ratePerDay, "", Math.round(eta)]]);
    csv("reward.csv", "slug,t,lato,prezzo,size,spread_c,avg_comp_score,score_mio,score_totale,punti_mercato,reward_stimata_per_giorno,reward_stimata_round",
      s.campioni);
    log(`✔ ESITO ${s.r.slug}: ${e.lato} (Gamma ${e.prezzi}, +${Math.round(eta)} s) | fill maker ${s.nMaker}/taker ${s.nTaker} | PNL ${pnl} $`);
  }
}

// ─── un round ──────────────────────────────────────────────────────────────
async function round(r) {
  log(`\n══════ ROUND ${r.slug} (${new Date(r.start * 1000).toISOString().slice(11, 19)} UTC) maxSpread ${r2(r.maxSpread)} $ · minSize ${r.minSize} · reward/giorno ${r.ratePerDay}`);
  const saldoPrima = PF.contante;
  const tick = [];
  const aperte = { up: null, dn: null };   // ordini limite passivi in book
  const posRound = [];                     // posizioni aperte di questo round
  let offset = CFG.OFFSET_INI, nMaker = 0, nTaker = 0, stop = 0, tenuti = 0;
  let sommaSpread = 0, nSpread = 0, sommaSize = 0, nSize = 0;
  const campioni = [];
  let ultimoCampione = -999, ultimaRisoluzione = 0, ultimoLog = 0;
  const size = Math.max(CFG.SIZE, r.minSize); // "coprire SIZE giù": mai sotto il minimo del mercato

  while (nowS() - r.start < WINDOW - 0.5) {
    const t = r4(nowS() - r.start);
    const [up, dn] = await Promise.all([book(r.up), book(r.dn)]);
    if (up && dn && up.bid !== null && dn.bid !== null && up.ask !== null && dn.ask !== null) {
      tick.push([t.toFixed(1), up.ask, Math.round(up.askSz), dn.ask, Math.round(dn.askSz), up.bid, dn.bid]);
      const mid = { up: r4((up.bid + up.ask) / 2), dn: r4((dn.bid + dn.ask) / 2) };
      const bk = { up, dn };

      // ── piazza / ripiazza gli ordini limite
      for (const l of ["up", "dn"]) {
        if (posRound.some((p) => p.lato === l)) continue;      // lato già riempito: niente nuovo ordine
        const b = bk[l];
        if (b.ask === null) continue;
        // il nostro bid non deve mai incrociare: resta sotto il best ask
        let prezzo = r4(Math.min(r4(mid[l] - offset), r4(b.ask - 0.01)));
        prezzo = Math.max(CFG.PREZZO_MIN, Math.min(CFG.PREZZO_MAX, prezzo));
        const vecchio = aperte[l];
        if (vecchio && Math.abs(vecchio.prezzo - prezzo) < CFG.REQUOTE_TOL) continue;
        if (vecchio) { annulla(r.slug, t, l, vecchio.prezzo, vecchio.size); sommaSize += vecchio.size; nSize++; }
        aperte[l] = { prezzo, size, t };
        piazza(r.slug, t, l, prezzo, size);
      }

      // ── fill passivi: il mercato viene a prenderci
      for (const l of ["up", "dn"]) {
        const o = aperte[l], b = bk[l];
        if (!o) continue;
        const incrocia = b.ask !== null && b.ask <= o.prezzo;
        if (incrocia) {
          if (riempi(r.slug, t, l, o.prezzo, o.size, "MAKER")) {
            nMaker++;
            posRound.push(PF.posizioni[PF.posizioni.length - 1]);
          }
          aperte[l] = null;
        }
      }

      // ── fill da what-if (solo se piazzi quote-agent.json)
      const qUp = whatif("up"), qDn = whatif("dn");
      for (const [l, q] of [["up", qUp], ["dn", qDn]]) {
        if (q === null) continue;
        if (posRound.some((p) => p.lato === l)) continue;
        if (t < CFG.WHATIF_DOPO_S) continue;
        if (riempi(r.slug, t, l, q, CFG.SIZE, "TAKER")) {
          nTaker++;
          posRound.push(PF.posizioni[PF.posizioni.length - 1]);
          if (aperte[l]) { annulla(r.slug, t, l, aperte[l].prezzo, aperte[l].size); aperte[l] = null; }
        }
      }

      // ── difesa: se il lato comprato perde, esce
      if (CFG.DIFESA) for (const p of [...posRound]) {
        const b = bk[p.lato];
        if (b.bid !== null && t - p.t >= CFG.STOP_DOPO_S && b.bid <= CFG.STOP_TENUTO && b.bidSz >= p.size) {
          vendi(r.slug, p, b.bid, t, "STOP");
          stop++;
          posRound.splice(posRound.indexOf(p), 1);
        }
      }

      // ── campione: spread dei nostri ordini e size piazzata
      if (t - ultimoCampione >= CFG.CAMPIONE_S) {
        ultimoCampione = t;
        const sUp = aperte.up ? r4((mid.up - aperte.up.prezzo) * 100) : "";
        const sDn = aperte.dn ? r4((mid.dn - aperte.dn.prezzo) * 100) : "";
        const szPiazzata = (aperte.up ? aperte.up.size : 0) + (aperte.dn ? aperte.dn.size : 0);
        const dentroSpread = [sUp, sDn].filter((s) => s !== "" && s <= r4(r.maxSpread * 100)).length;
        sommaSpread += (sUp || 0) + (sDn || 0); nSpread += dentroSpread;
        sommaSize += szPiazzata; nSize++;
        campioni.push([r.slug, t, "up", aperte.up?.prezzo ?? "", aperte.up?.size ?? "", sUp, "", "", "",
                       "", "", ""]);
        campioni.push([r.slug, t, "dn", aperte.dn?.prezzo ?? "", aperte.dn?.size ?? "", sDn, "", "", "",
                       "", "", ""]);
      }

      if (t - ultimoLog >= CFG.CAMPIONE_S) {
        ultimoLog = t;
        log(`   [${Math.round(t)}s] mid up ${mid.up}/dn ${mid.dn} · miei ordini ${aperte.up ? r2(aperte.up.prezzo) : "—"}/${aperte.dn ? r2(aperte.dn.prezzo) : "—"} · fill ${nMaker} · posizioni ${posRound.length} · contante ${r2(PF.contante)}`);
      }
    }
    if (nowS() - ultimaRisoluzione >= CFG.ESITO_OGNI_S) { ultimaRisoluzione = nowS(); await risolvi(); }
    await sleep(CFG.POLL_MS);
  }

  const tFine = r4(nowS() - r.start);
  for (const l of ["up", "dn"]) if (aperte[l]) { annulla(r.slug, tFine, l, aperte[l].prezzo, aperte[l].size); sommaSize += aperte[l].size; nSize++; }

  fs.writeFileSync(path.join(CFG.OUT_DIR, "tick", `${r.slug}.csv`),
    "t,up_ask,up_size,dn_ask,dn_size,up_bid,dn_bid\n" + tick.map((x) => x.join(",")).join("\n") + "\n");
  const aperti = PF.posizioni.filter((p) => p.slug === r.slug);
  log(`   fine round · fill maker ${nMaker} · taker ${nTaker} · stop ${stop} · aperte ${aperti.map((p) => `${p.lato}@${p.prezzo}`).join(" ") || "nessuna"} → esito da Gamma tra ${CFG.ESITO_DOPO_S} s`);
  SOSPESI.push({ r, fine: r.start + WINDOW, saldoPrima, ultimoTentativo: 0,
    nMaker, nTaker, stop, tenuti, sizeMedia: nSize ? sommaSize / nSize : 0,
    spreadMedio: nSpread ? r4(sommaSpread / nSpread) : "", campioni });
}

// ─── riepilogo ─────────────────────────────────────────────────────────────
function riepilogo() {
  const f = path.join(CFG.OUT_DIR, "round.csv");
  const righe = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")) : [];
  const ok = righe.filter((x) => x[1] === "up" || x[1] === "dn");
  const pnl = r4(ok.reduce((s, x) => s + Number(x[8]), 0));
  const n = ok.length || 1;
  const fillMaker = ok.reduce((s, x) => s + Number(x[2]), 0);
  const fillTaker = ok.reduce((s, x) => s + Number(x[3]), 0);
  const stop = ok.reduce((s, x) => s + Number(x[5]), 0);
  const fermi = r4(PF.posizioni.reduce((s, p) => s + p.prezzo * p.size, 0));
  const saldo = r4(PF.contante + fermi);
  const atteso = r4(CFG.CAPITALE + pnl + (righe.length - ok.length ? 0 : 0));
  const txt =
`bot maker 5m BTC (paper, senza reward vere)
capitale ${CFG.CAPITALE}
round_risolti ${ok.length}
round_non_risolti ${righe.length - ok.length + SOSPESI.length}
fill_maker ${fillMaker}  (${r4(fillMaker / n)} per round)
fill_taker_whatif ${fillTaker}
stop_scattati ${stop}
pnl ${pnl}  (per round ${r4(pnl / n)})
contante ${PF.contante}
posizioni_aperte_al_costo ${fermi}
saldo ${saldo}
atteso ${atteso}
quadratura ${Math.abs(atteso - saldo) < 0.005 ? "OK" : "FALLITA"}
fee non applicate · rebate maker non conteggiato · reward non conteggiate
`;
  fs.writeFileSync(path.join(CFG.OUT_DIR, "riepilogo.txt"), txt);
  log("\n══════ RIEPILOGO\n" + txt);
}

// ─── main ──────────────────────────────────────────────────────────────────
async function main() {
  log(`══ xmaker · ${CFG.ROUNDS} round · capitale ${CFG.CAPITALE} $ DEMO · difesa ${CFG.DIFESA ? `attiva (stop ${CFG.STOP_TENUTO})` : "spenta"}`);
  log(`   NB: stima delle reward soltanto. Le reward vere richiedono ordini reali nel book.`);
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
main().catch((e) => { log("[fatale]", e.stack || e.message); process.exit(1); });
