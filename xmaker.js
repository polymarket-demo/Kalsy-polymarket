// ═══════════════════════════════════════════════════════════════════════════
// xmaker.js — PAPER TRADING · bot MAKER sulle 5 minuti BTC su/giù di Polymarket
//
// COSA FA
//   1. Ogni round piazza DUE ordini limite passivi (uno per lato: Up e Down),
//      a una distanza dal midpoint letta dal book. Poi li LASCIA FERMI.
//   2. Ripiazza solo se il midpoint si sposta davvero (REQUOTE_TOL = 2 cent),
//      non a ogni tick: un maker che insegue il mercato non è mai nel book.
//   3. La size degli ordini è CFG.SIZE (5 share): il minimo premiato dal
//      mercato viene stampato nel log ma NON usato per dimensionare, altrimenti
//      con capitale DEMO da 50 $ basta un fill.
//   4. Un ordine si considera riempito quando il best ask scende al suo prezzo
//      o sotto: a quel punto il bot è stato preso come maker.
//   5. Se dopo il fill il lato perde (bid <= STOP_TENUTO dopo STOP_DOPO_S),
//      vende: è la difesa contro il "riempimento tossico". DIFESA=0 la spegne.
//   6. A fine round le posizioni restanti incassano 1,00 se il lato vince,
//      0 se perde. L'esito si legge SOLO da Gamma, differito (90 s +).
//   7. Ogni 60 s una riga di stato e un campione per la stima delle reward.
//
// ATTENZIONE — questo bot NON piazza ordini veri e NON guadagna reward vere.
// Le reward vere richiedono ordini reali nel book e capitale reale: qui se ne
// stima solo il punteggio. Le fee sono a zero e il rebate maker non è incluso.
//
// Uso:   node xmaker.js              (10 round)
//        ROUNDS=30 node xmaker.js
//        DIFESA=0 node xmaker.js     (confronto senza difesa)
// Output in out-mk/: ordini.csv, round.csv, esiti.csv, reward.csv,
//   riepilogo.txt, tick/<slug>.csv, log.txt
// Node 18+ (fetch nativo). Nessuna dipendenza.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";

const CFG = {
  CAPITALE: 50,
  SIZE: Number(process.env.SIZE || 5), // share per ordine: 5, non il minimo del mercato
  OFFSET_INI: 0.035,     // primo tentativo: 3,5 centesimi dal midpoint
  OFFSET_MIN: 0.01,      // mai meno di 1 centesimo dal midpoint
  OFFSET_PASSI: 0.005,
  REQUOTE_TOL: 0.02,     // ripiazza solo se il midpoint si muove di 2 cent
  MIN_RESTING_S: 5,      // non annullare un ordine prima di 5 s: resta nel book
  PREZZO_MIN: 0.05,
  PREZZO_MAX: 0.95,
  // difesa anti fill tossico
  DIFESA: process.env.DIFESA !== "0",
  STOP_TENUTO: Number(process.env.STOP || 0.35),
  STOP_DOPO_S: 30,
  // round
  ROUNDS: Number(process.env.ROUNDS || 10),
  POLL_MS: 1000,
  CAMPIONE_S: 60,
  ESITO_DOPO_S: 90,
  ESITO_OGNI_S: 10,
  ESITO_MAX_S: 900,
  OUT_DIR: process.env.OUT_DIR || "out-mk",
};
const WINDOW = 300;
const INDIRIZZO_GAMMA = "[gamma-api.polymarket.com](https://gamma-api.polymarket.com)";
const INDIRIZZO_CLOB = "[clob.polymarket.com](https://clob.polymarket.com)";

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
const muovi = (importo) => { PF.contante = r4(PF.contante + importo); };
function ordine(o) {
  csv("ordini.csv", "slug,t,lato,azione,prezzo,size,importo,secondi_in_book,contante_dopo",
    [[o.slug, o.t, o.lato, o.azione, r4(o.prezzo), o.size, r4(o.importo), o.resting ?? "", PF.contante]]);
  log(`   ${o.azione.padEnd(13)} ${o.lato} ${o.size}@${r2(o.prezzo)}${o.resting != null ? ` (in book ${o.resting}s)` : ""} = ${o.importo >= 0 ? "+" : ""}${r2(o.importo)} $ | contante ${r2(PF.contante)}`);
}
function riempi(slug, t, lato, prezzo, size) {
  const costo = r4(prezzo * size);
  if (costo > PF.contante + 1e-9) { log(`   RIFIUTATO ${lato}: contante ${r2(PF.contante)} < ${costo}`); return false; }
  muovi(-costo);
  PF.posizioni.push({ slug, lato, prezzo, size, t });
  ordine({ slug, t, lato, azione: "FILL_MAKER", prezzo, size, importo: -costo });
  return true;
}
function vendi(p, prezzo, t, azione) {
  const inc = r4(prezzo * p.size);
  muovi(inc);
  PF.posizioni.splice(PF.posizioni.indexOf(p), 1);
  ordine({ slug: p.slug, t, lato: p.lato, azione, prezzo, size: p.size, importo: inc,
           resting: r4(t - p.t) });
}

// ─── mercato ───────────────────────────────────────────────────────────────
async function trovaRound(start) {
  const slug = `btc-updown-5m-${start}`;
  const ev = await jget(`${INDIRIZZO_GAMMA}/events?slug=${slug}`);
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
  return { slug, start, up: tok[iUp], dn: tok[1 - iUp], minSize, maxSpread: maxSpreadC / 100, ratePerDay,
           feeBps: Number(m.feeRateBps ?? 0) || 0 };
}
async function book(token) {
  try {
    const b = await jget(`${INDIRIZZO_CLOB}/book?token_id=${token}`);
    const lv = (a) => (a || []).map((x) => [parseFloat(x.price), parseFloat(x.size)]).filter((x) => x[1] > 0 && isFinite(x[0]));
    const asks = lv(b.asks).sort((a, c) => a[0] - c[0]);
    const bids = lv(b.bids).sort((a, c) => c[0] - a[0]);
    return { ask: asks[0]?.[0] ?? null, askSz: asks[0]?.[1] ?? 0, bid: bids[0]?.[0] ?? null, bidSz: bids[0]?.[1] ?? 0 };
  } catch (_) { return null; }
}

// ─── esito da Gamma, differito ─────────────────────────────────────────────
const SOSPESI = [];
async function esitoGamma(slug) {
  const ev = await jget(`${INDIRIZZO_GAMMA}/events?slug=${slug}`);
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
        csv("round.csv", "slug,esito,fill_maker,fill_tenuti,stop,size_ordine,resting_medio_s,spread_medio_c,reward_giorno,pnl,secondi_esito",
          [[s.r.slug, "NON_RISOLTO", s.nFill, s.tenuti, s.stop, CFG.SIZE, s.restingMedio, s.spreadMedio, s.r.ratePerDay, "", Math.round(eta)]]);
        log(`⚠️  ${s.r.slug} NON RISOLTO dopo ${Math.round(eta)} s — posizioni ferme al costo, fuori dal PNL`);
      }
      continue;
    }
    for (const p of [...PF.posizioni.filter((x) => x.slug === s.r.slug)])
      vendi(p, p.lato === e.lato ? 1 : 0, 300, p.lato === e.lato ? "SCADENZA_VINTA" : "SCADENZA_PERSA");
    const pnl = r4(PF.contante - s.saldoPrima);
    SOSPESI.splice(SOSPESI.indexOf(s), 1);
    csv("esiti.csv", "slug,esito,prezzi,secondi_dopo_fine", [[s.r.slug, e.lato, e.prezzi, Math.round(eta)]]);
    csv("round.csv", "slug,esito,fill_maker,fill_tenuti,stop,size_ordine,resting_medio_s,spread_medio_c,reward_giorno,pnl,secondi_esito",
      [[s.r.slug, e.lato, s.nFill, s.tenuti, s.stop, CFG.SIZE, s.restingMedio, s.spreadMedio, s.r.ratePerDay, pnl, Math.round(eta)]]);
    csv("reward.csv", "slug,t,lato,prezzo_piazzato,size,spread_c,dentro_max_spread,max_spread_c,reward_giorno",
      s.campioni);
    log(`✔ ESITO ${s.r.slug}: ${e.lato} (Gamma ${e.prezzi}, +${Math.round(eta)} s) | fill ${s.nFill} · tenuti ${s.tenuti} · stop ${s.stop} | PNL ${pnl} $`);
  }
}

// ─── un round ──────────────────────────────────────────────────────────────
async function round(r) {
  log(`\n══════ ROUND ${r.slug} (${new Date(r.start * 1000).toISOString().slice(11, 19)} UTC)`);
  log(`   size ordini ${CFG.SIZE} share · minimo premiato dal mercato ${r.minSize} (NON usato per dimensionare)`);
  log(`   max spread premiato ${r2(r.maxSpread)} $ · reward/giorno ${r.ratePerDay} · offset ${CFG.OFFSET_INI}`);
  const saldoPrima = PF.contante;
  const tick = [];
  const ap = { up: null, dn: null };          // ordini passivi in book
  const posRound = [];                        // posizioni di questo round ancora aperte
  let offset = CFG.OFFSET_INI, nFill = 0, nTenuti = 0, stop = 0;
  let sSpread = 0, nSpread = 0, sResting = 0, nResting = 0;
  const campioni = [];
  let ultimoCampione = -999, ultimaRisoluzione = 0, ultimoLog = -999;

  while (nowS() - r.start < WINDOW - 0.5) {
    const t = r4(nowS() - r.start);
    const [up, dn] = await Promise.all([book(r.up), book(r.dn)]);
    if (up && dn && up.bid !== null && dn.bid !== null && up.ask !== null && dn.ask !== null) {
      tick.push([t.toFixed(1), up.ask, Math.round(up.askSz), dn.ask, Math.round(dn.askSz), up.bid, dn.bid]);
      const bk = { up, dn };
      const mid = { up: r4((up.bid + up.ask) / 2), dn: r4((dn.bid + dn.ask) / 2) };

      // ── piazza / ripiazza con calma
      for (const l of ["up", "dn"]) {
        if (posRound.some((p) => p.lato === l)) continue;      // lato già riempito
        const b = bk[l];
        const desiderato = Math.max(CFG.PREZZO_MIN,
          Math.min(CFG.PREZZO_MAX, r4(Math.min(r4(mid[l] - offset), r4(b.ask - 0.01)))));
        const vecchio = ap[l];
        if (vecchio) {
          // non toccare un ordine appena messo: deve restare nel book
          if (t - vecchio.t < CFG.MIN_RESTING_S) continue;
          // e non toccarlo se il prezzo è rimasto dove lo volevamo
          if (Math.abs(vecchio.prezzo - desiderato) < CFG.REQUOTE_TOL) continue;
          ordine({ slug: r.slug, t, lato: l, azione: "ANNULLA", prezzo: vecchio.prezzo, size: vecchio.size,
                   importo: 0, resting: r4(t - vecchio.t) });
          sResting += r4(t - vecchio.t); nResting++;
        }
        ap[l] = { prezzo: desiderato, size: CFG.SIZE, t };
        ordine({ slug: r.slug, t, lato: l, azione: "PIAZZA_LIMITE", prezzo: desiderato, size: CFG.SIZE, importo: 0 });
      }

      // ── fill passivi: il mercato viene a prenderci
      for (const l of ["up", "dn"]) {
        const o = ap[l], b = bk[l];
        if (!o) continue;
        if (b.ask !== null && b.ask <= o.prezzo) {
          ordine({ slug: r.slug, t, lato: l, azione: "ANNULLA", prezzo: o.prezzo, size: o.size,
                   importo: 0, resting: r4(t - o.t) });
          sResting += r4(t - o.t); nResting++;
          if (riempi(r.slug, t, l, o.prezzo, o.size)) { nFill++; posRound.push(PF.posizioni[PF.posizioni.length - 1]); }
          ap[l] = null;
        }
      }

      // ── difesa: se il lato comprato perde, esce
      if (CFG.DIFESA) for (const p of [...posRound]) {
        const b = bk[p.lato];
        if (b.bid !== null && t - p.t >= CFG.STOP_DOPO_S && b.bid <= CFG.STOP_TENUTO && b.bidSz >= p.size) {
          vendi(p, b.bid, t, "STOP");
          stop++;
          posRound.splice(posRound.indexOf(p), 1);
        }
      }
      nTenuti = posRound.length;

      // ── campione per la stima reward
      if (t - ultimoCampione >= CFG.CAMPIONE_S) {
        ultimoCampione = t;
        for (const l of ["up", "dn"]) {
          const o = ap[l];
          const sp = o ? r4((mid[l] - o.prezzo) * 100) : "";
          if (o) { sSpread += sp; nSpread++; }
          campioni.push([r.slug, t, l, o?.prezzo ?? "", o?.size ?? "", sp,
                         sp === "" ? "" : (sp <= r4(r.maxSpread * 100) ? "SI" : "NO"), r4(r.maxSpread * 100), r.ratePerDay]);
        }
      }

      if (t - ultimoLog >= CFG.CAMPIONE_S) {
        ultimoLog = t;
        log(`   [${Math.round(t)}s] mid up ${mid.up}/dn ${mid.dn} · miei ordini ${ap.up ? r2(ap.up.prezzo) : "—"}/${ap.dn ? r2(ap.dn.prezzo) : "—"} · fill ${nFill} · posizioni ${posRound.length} · contante ${r2(PF.contante)}`);
      }
    }
    if (nowS() - ultimaRisoluzione >= CFG.ESITO_OGNI_S) { ultimaRisoluzione = nowS(); await risolvi(); }
    await sleep(CFG.POLL_MS);
  }

  const tFine = r4(nowS() - r.start);
  for (const l of ["up", "dn"]) if (ap[l]) {
    ordine({ slug: r.slug, t: tFine, lato: l, azione: "ANNULLA", prezzo: ap[l].prezzo, size: ap[l].size,
             importo: 0, resting: r4(tFine - ap[l].t) });
    sResting += r4(tFine - ap[l].t); nResting++;
  }

  fs.writeFileSync(path.join(CFG.OUT_DIR, "tick", `${r.slug}.csv`),
    "t,up_ask,up_size,dn_ask,dn_size,up_bid,dn_bid\n" + tick.map((x) => x.join(",")).join("\n") + "\n");
  const aperti = PF.posizioni.filter((p) => p.slug === r.slug);
  log(`   fine round · fill ${nFill} · stop ${stop} · in book medio ${nResting ? r2(sResting / nResting) : 0}s · aperte ${aperti.map((p) => `${p.lato}@${p.prezzo}`).join(" ") || "nessuna"} → esito tra ${CFG.ESITO_DOPO_S}s`);
  SOSPESI.push({ r, fine: r.start + WINDOW, saldoPrima, ultimoTentativo: 0, nFill, nTenuti, stop,
    restingMedio: nResting ? r4(sResting / nResting) : "", spreadMedio: nSpread ? r4(sSpread / nSpread) : "", campioni });
}

// ─── riepilogo ─────────────────────────────────────────────────────────────
function riepilogo() {
  const f = path.join(CFG.OUT_DIR, "round.csv");
  const righe = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")) : [];
  const ok = righe.filter((x) => x[1] === "up" || x[1] === "dn");
  const n = ok.length || 1;
  const pnl = r4(ok.reduce((s, x) => s + Number(x[9]), 0));
  const fermi = r4(PF.posizioni.reduce((s, p) => s + p.prezzo * p.size, 0));
  const saldo = r4(PF.contante + fermi);
  const atteso = r4(CFG.CAPITALE + pnl);
  const txt =
`bot maker 5m BTC (paper, senza reward vere)
capitale ${CFG.CAPITALE}
size_ordine ${CFG.SIZE}
round_risolti ${ok.length}
round_non_risolti ${righe.length - ok.length + SOSPESI.length}
fill_maker ${ok.reduce((s, x) => s + Number(x[2]), 0)}  (${r4(ok.reduce((s, x) => s + Number(x[2]), 0) / n)} per round)
stop_scattati ${ok.reduce((s, x) => s + Number(x[4]), 0)}
secondi_in_book_medi ${ok.length ? r4(ok.reduce((s, x) => s + Number(x[5] || 0), 0) / ok.length) : 0}
spread_medio_cent ${ok.length ? r4(ok.reduce((s, x) => s + Number(x[6] || 0), 0) / ok.length) : 0}
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
  log(`══ xmaker · ${CFG.ROUNDS} round · capitale ${CFG.CAPITALE} $ DEMO · size ${CFG.SIZE} · difesa ${CFG.DIFESA ? `attiva (stop ${CFG.STOP_TENUTO})` : "spenta"}`);
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
