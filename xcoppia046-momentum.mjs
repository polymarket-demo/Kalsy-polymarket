// ═══════════════════════════════════════════════════════════════════════════
// xcoppia-momentum.js — PAPER TRADING, Polymarket BTC su/giù 5 minuti
//
// Due strategie indipendenti, conti separati, stesso portafoglio DEMO:
//
//   A) COPPIA 0,46
//      - compra UP e DN (5 share ciascuno) appena l'ask è ≤ 0,46 (e ≥ 0,05)
//      - ogni lato si compra UNA volta sola per round
//      - se dopo 60 s dal fill c'è ancora un lato solo e il suo bid è ≤ 0,40
//        → vende quel lato al bid; da lì A non compra più in quel round
//
//   B) MOMENTUM 0,90
//      - il primo lato con ask tra 0,90 e 0,95 → compra 5 share all'ask
//      - se il bid scende a ≤ 0,70 → vende al bid (stop)
//      - una sola entrata per round
//
// ESITO: si legge SOLO da Gamma (closed=true e outcomePrices esattamente 1/0),
// dal 90° secondo dopo la fine del round, riprovando ogni 10 s per 15 minuti.
// Nessun esito dedotto dai prezzi. Un round senza esito resta NON RISOLTO e
// non entra nel PNL.
//
// Prezzi: book letto via REST (clob /book) ogni secondo, per entrambi i token.
// Fill simulati: acquisto al best ask, vendita al best bid, solo se la
// quantità al primo livello copre le 5 share. Fee NON applicate (feeRateBps
// del mercato viene solo registrato in round.csv).
//
// Uso:   node xcoppia-momentum.js            (10 round)
//        ROUNDS=30 node xcoppia-momentum.js
// Output in out-cm/: ordini.csv, round.csv, esiti.csv, riepilogo.txt,
//                    tick/<slug>.csv, log.txt
// Node 18+ (usa fetch nativo). Nessuna dipendenza.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";

const CFG = {
  CAPITALE: 50,
  SHARES: 5,
  PREZZO_MIN: 0.05,
  // A
  A_QUOTA: 0.46,
  A_USCITA: 0.40,
  A_USCITA_MIN_S: 60,
  // B
  B_MIN: 0.90,
  B_MAX: 0.95,
  B_STOP: 0.70,
  // round
  ROUNDS: Number(process.env.ROUNDS || 10),
  POLL_MS: 1000,
  ESITO_DOPO_S: 90,
  ESITO_OGNI_S: 10,
  ESITO_MAX_S: 900,
  OUT_DIR: process.env.OUT_DIR || "out-cm",
};

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const WINDOW = 300;

// ─── utilità ───────────────────────────────────────────────────────────────
const r4 = (x) => Math.round(x * 10000) / 10000;
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
// Ogni movimento di cassa è legato a (slug, strategia): il PNL di un round
// per strategia = somma dei suoi flussi, calcolato solo a esito letto.
const PF = { contante: CFG.CAPITALE, flussi: new Map() }; // key slug|strat -> somma
function flusso(slug, strat, importo) {
  const k = `${slug}|${strat}`;
  PF.flussi.set(k, r4((PF.flussi.get(k) || 0) + importo));
  PF.contante = r4(PF.contante + importo);
}
function ordine(o) {
  csv("ordini.csv", "slug,strat,t,lato,tipo,prezzo,shares,importo,contante_dopo",
    [[o.slug, o.strat, o.t, o.lato, o.tipo, o.prezzo, o.shares, o.importo, PF.contante]]);
  log(`   ${o.strat} ${o.tipo.padEnd(9)} ${o.lato} ${o.shares}@${o.prezzo} = ${o.importo >= 0 ? "+" : ""}${o.importo} $ | contante ${PF.contante}`);
}
function compra(slug, strat, lato, prezzo, t, pos) {
  const costo = r4(prezzo * CFG.SHARES);
  if (costo > PF.contante + 1e-9) { log(`   ${strat} RIFIUTATO ${lato}: contante ${PF.contante} < ${costo}`); return false; }
  flusso(slug, strat, -costo);
  pos.push({ strat, lato, shares: CFG.SHARES, prezzo });
  ordine({ slug, strat, t, lato, tipo: "ACQUISTO", prezzo, shares: CFG.SHARES, importo: -costo });
  return true;
}
function vendi(slug, p, prezzo, t, tipo, pos) {
  const inc = r4(prezzo * p.shares);
  flusso(slug, p.strat, inc);
  pos.splice(pos.indexOf(p), 1);
  ordine({ slug, strat: p.strat, t, lato: p.lato, tipo, prezzo, shares: p.shares, importo: inc });
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
  if (iUp < 0 || !tok?.[0] || !tok?.[1]) return null;
  return { slug, start, up: tok[iUp], dn: tok[1 - iUp], feeBps: Number(m.feeRateBps ?? 0) || 0 };
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
const SOSPESI = []; // { r, pos, fine, ultimoTentativo }
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
    let e = null;
    try { e = await esitoGamma(s.r.slug); } catch (_) {}
    if (!e) {
      if (eta > CFG.ESITO_MAX_S) {
        SOSPESI.splice(SOSPESI.indexOf(s), 1);
        csv("esiti.csv", "slug,esito,prezzi,secondi_dopo_fine", [[s.r.slug, "NON_RISOLTO", "", Math.round(eta)]]);
        csv("round.csv", "slug,esito,pnl_A,pnl_B,pnl_tot,contante_dopo,feeBps", [[s.r.slug, "NON_RISOLTO", "", "", "", PF.contante, s.r.feeBps]]);
        log(`⚠️  ${s.r.slug} NON RISOLTO dopo ${Math.round(eta)} s — escluso dal PNL (posizioni ferme al costo)`);
      }
      continue;
    }
    for (const p of [...s.pos]) vendi(s.r.slug, p, p.lato === e.lato ? 1 : 0, 300, "SCADENZA", s.pos);
    const a = PF.flussi.get(`${s.r.slug}|A`) || 0, b = PF.flussi.get(`${s.r.slug}|B`) || 0;
    SOSPESI.splice(SOSPESI.indexOf(s), 1);
    csv("esiti.csv", "slug,esito,prezzi,secondi_dopo_fine", [[s.r.slug, e.lato, e.prezzi, Math.round(eta)]]);
    csv("round.csv", "slug,esito,pnl_A,pnl_B,pnl_tot,contante_dopo,feeBps", [[s.r.slug, e.lato, a, b, r4(a + b), PF.contante, s.r.feeBps]]);
    log(`✔ ESITO ${s.r.slug}: ${e.lato} (Gamma ${e.prezzi}, +${Math.round(eta)} s) | PNL A ${a} · B ${b} · tot ${r4(a + b)}`);
  }
}

// ─── un round ──────────────────────────────────────────────────────────────
async function round(r) {
  log(`\n══════ ROUND ${r.slug} (${new Date(r.start * 1000).toISOString().slice(11, 19)} UTC) feeBps ${r.feeBps}`);
  const pos = [], tick = [];
  const A = { fill: {}, uscito: false };
  const B = { fatto: false, pos: null };
  let ultimaRisoluzione = 0;

  while (nowS() - r.start < WINDOW - 0.5) {
    const t = r4(nowS() - r.start);
    const [up, dn] = await Promise.all([book(r.up), book(r.dn)]);
    if (up && dn) {
      tick.push([t.toFixed(1), up.ask ?? "", Math.round(up.askSz), dn.ask ?? "", Math.round(dn.askSz), up.bid ?? "", dn.bid ?? ""]);
      const bk = { up, dn };

      // A — acquisti
      if (!A.uscito) for (const l of ["up", "dn"]) {
        const b = bk[l];
        if (A.fill[l] === undefined && b.ask !== null && b.ask <= CFG.A_QUOTA && b.ask >= CFG.PREZZO_MIN && b.askSz >= CFG.SHARES)
          if (compra(r.slug, "A", l, b.ask, t, pos)) A.fill[l] = t;
      }
      // A — uscita del lato singolo
      const latiA = Object.keys(A.fill);
      if (!A.uscito && latiA.length === 1) {
        const l = latiA[0], b = bk[l], p = pos.find((x) => x.strat === "A" && x.lato === l);
        if (p && b.bid !== null && t - A.fill[l] >= CFG.A_USCITA_MIN_S && b.bid <= CFG.A_USCITA && b.bidSz >= p.shares) {
          vendi(r.slug, p, b.bid, t, "USCITA", pos);
          A.uscito = true;
        }
      }
      // B — entrata
      if (!B.fatto) for (const l of ["up", "dn"]) {
        const b = bk[l];
        if (b.ask !== null && b.ask >= CFG.B_MIN && b.ask <= CFG.B_MAX && b.askSz >= CFG.SHARES) {
          if (compra(r.slug, "B", l, b.ask, t, pos)) B.pos = pos[pos.length - 1];
          B.fatto = true;
          break;
        }
      }
      // B — stop
      if (B.pos && pos.includes(B.pos)) {
        const b = bk[B.pos.lato];
        if (b.bid !== null && b.bid <= CFG.B_STOP && b.bidSz >= B.pos.shares) vendi(r.slug, B.pos, b.bid, t, "STOP", pos);
      }
    }
    if (nowS() - ultimaRisoluzione >= CFG.ESITO_OGNI_S) { ultimaRisoluzione = nowS(); await risolvi(); }
    await sleep(CFG.POLL_MS);
  }

  fs.writeFileSync(path.join(CFG.OUT_DIR, "tick", `${r.slug}.csv`),
    "t,up_ask,up_size,dn_ask,dn_size,up_bid,dn_bid\n" + tick.map((x) => x.join(",")).join("\n") + "\n");
  const aperte = pos.map((p) => `${p.strat}:${p.lato}@${p.prezzo}`).join(" ") || "nessuna";
  log(`   fine round · coppia A ${Object.keys(A.fill).length === 2 ? "SI" : "NO"} · B ${B.fatto ? "entrato" : "no"} · aperte: ${aperte} → esito da Gamma tra ${CFG.ESITO_DOPO_S} s`);
  SOSPESI.push({ r, pos, fine: r.start + WINDOW, ultimoTentativo: 0 });
}

// ─── riepilogo con quadratura ──────────────────────────────────────────────
function riepilogo() {
  const f = path.join(CFG.OUT_DIR, "round.csv");
  const righe = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")) : [];
  const ok = righe.filter((x) => x[1] === "up" || x[1] === "dn");
  const nr = righe.length - ok.length;
  const sA = r4(ok.reduce((s, x) => s + Number(x[2]), 0));
  const sB = r4(ok.reduce((s, x) => s + Number(x[3]), 0));
  const fermi = r4(SOSPESI.reduce((s, x) => s + x.pos.reduce((q, p) => q + p.prezzo * p.shares, 0), 0));
  // posizioni dei round NON_RISOLTO restano al costo: le ricaviamo dai flussi
  let costoNR = 0;
  for (const x of righe.filter((y) => y[1] === "NON_RISOLTO"))
    costoNR += -(PF.flussi.get(`${x[0]}|A`) || 0) - (PF.flussi.get(`${x[0]}|B`) || 0);
  const atteso = r4(CFG.CAPITALE + sA + sB);
  const saldo = r4(PF.contante + fermi + costoNR);
  const quadra = Math.abs(atteso - saldo) < 0.005;
  const n = ok.length || 1;
  const txt =
`strategia coppia046 + momentum090
capitale ${CFG.CAPITALE}
round_risolti ${ok.length}
round_non_risolti ${nr + SOSPESI.length}
pnl_A ${sA}  (per round ${r4(sA / n)})
pnl_B ${sB}  (per round ${r4(sB / n)})
pnl_tot ${r4(sA + sB)}  (per round ${r4((sA + sB) / n)})
contante ${PF.contante}
posizioni_non_risolte_al_costo ${r4(fermi + costoNR)}
saldo ${saldo}
atteso ${atteso}
quadratura ${quadra ? "OK" : "FALLITA"}
fee non applicate
`;
  fs.writeFileSync(path.join(CFG.OUT_DIR, "riepilogo.txt"), txt);
  log("\n══════ RIEPILOGO\n" + txt);
}

// ─── main ──────────────────────────────────────────────────────────────────
async function main() {
  log(`══ xcoppia-momentum · ${CFG.ROUNDS} round · capitale ${CFG.CAPITALE} $ DEMO`);
  let fatti = 0;
  while (fatti < CFG.ROUNDS) {
    // si entra solo all'INIZIO di un round, mai a metà
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

let chiusura = false;
async function stop() {
  if (chiusura) process.exit(0);
  chiusura = true;
  log("\n[interrotto] Ctrl+C di nuovo per uscire subito; altrimenti riepilogo con i round aperti NON risolti.");
  riepilogo();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
main().catch((e) => { log("[fatale]", e.stack || e.message); process.exit(1); });
