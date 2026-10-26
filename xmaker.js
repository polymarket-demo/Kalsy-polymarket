// ═══════════════════════════════════════════════════════════════════════════
// xmaker.js — PAPER TRADING · bot MAKER sulle 5 minuti BTC su/giù di Polymarket
//
// Due ordini limite passivi per round (uno per lato), lasciati nel book.
// Size 5 share. Difesa anti fill tossico attivabile con DIFESA=0/1.
// Esito letto SOLO da Gamma, differito. Non piazza ordini veri.
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

const H = "ht" + "tp" + "s:/" + "/";
const D = "gamma-api.polymarket.com";
const E = "clob.polymarket.com";
const g = (q) => H + D + "/events?slug=" + q;
const pentola = (q) => H + E + "/book?token_id=" + q;

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

async function trovaRound(start) {
  const slug = `btc-updown-5m-${start}`;
  const ev = await jget(g(slug));
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
    const b = await jget(pentola(token));
    const lv = (a) => (a || []).map((x) => [parseFloat(x.price), parseFloat(x.size)]).filter((x) => x[1] > 0 && isFinite(x[0]));
    const asks = lv(b.asks).sort((a, c) => a[0] - c[0]);
    const bids = lv(b.bids).sort((a, c) => c[0] - a[0]);
    return { ask: asks[0]?.[0] ?? null, askSz: asks[0]?.[1] ?? 0, bid: bids[0]?.[0] ?? null, bidSz: bids[0]?.[1] ?? 0 };
  } catch (_) { return null; }
}

const SOSPESI = [];
async function esitoGamma(slug) {
  const ev = await jget(g(slug));
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
        log(`⚠️  ${s.r.slug} NON RISOLTO dopo ${Math.round(eta)} s — fuori dal PNL`);
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
    csv("reward.csv", "slug,t,lato,prezzo_piazzato,size,spread_c,dentro_max_spread,max_spread_c,reward_giorno", s.campioni);
    log(`✔ ESITO ${s.r.slug}: ${e.lato} (Gamma ${e.prezzi}, +${Math.round(eta)} s) | fill ${s.nFill} · tenuti ${s.tenuti} · stop ${s.stop} | PNL ${pnl} $`);
  }
}
