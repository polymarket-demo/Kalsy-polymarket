// ═══════════════════════════════════════════════════════════════════════════
// xstoria.js — BACKTEST del "farming" dei premi di liquidita' (SOLO LETTURA)
//
// Domanda: nei mercati Polymarket con premio, tenere ordini su entrambi i lati
// vicino al prezzo medio rende piu' di quanto si perde quando il prezzo si muove
// e gli ordini vengono presi?
//
// 1. Prende tutti i mercati con premio e una fotografia dei book (come xpremi.js).
// 2. Tiene solo i candidati "tranquilli": book vero (spread entro il massimo del
//    premio), concorrenza presente, prezzo tra 0,15 e 0,85, fine ad almeno 7 giorni.
// 3. Per i migliori N scarica la storia dei prezzi minuto per minuto (ultima settimana).
// 4. Simula un bot che ogni minuto mette un bid su YES appena sotto il medio e un bid
//    su NO appena sopra (= vendere YES), con CAPITALE $ divisi sui due lati:
//      - viene ESEGUITO quando il minuto dopo il prezzo attraversa il suo ordine;
//      - accumula posizione fino a un limite, poi smette di comprare da quel lato;
//      - incassa il premio ogni minuto in proporzione al suo punteggio
//        (formula ufficiale, concorrenza presa dalla fotografia).
//    Alla fine la posizione rimasta e' valutata all'ultimo prezzo.
//
// PREZZI E LIMITI DELLA SIMULAZIONE
//   - Conta solo le esecuzioni in cui il prezzo ATTRAVERSA l'ordine (quelle "cattive":
//     qualcuno sapeva qualcosa). Nella realta' ci sono anche esecuzioni da trader casuali
//     senza movimento di prezzo, che fanno guadagnare lo spread: qui non ci sono, quindi
//     su questo punto la stima e' PRUDENTE.
//   - Ma assume anche che il bot si aggiorni ogni minuto e sia sempre primo in coda e
//     che la concorrenza resti quella della fotografia: su questi punti e' OTTIMISTA.
//   - Il prezzo storico e' quello pubblicato da Polymarket (non il book completo).
// ═══════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";

const CFG = {
  CAPITALE: Number(process.env.CAPITALE || 100),
  CANDIDATI: Number(process.env.CANDIDATI || 200),
  INTERVALLO: process.env.INTERVALLO || "1w",        // storia: 1d, 1w, 1m
  MAX_POS: Number(process.env.MAX_POS || 2),          // al massimo MAX_POS ordini netti per lato (2 × 50 $ = tutto il capitale)
  GIORNI_MIN_FINE: 7,
  OUT_DIR: process.env.OUT_DIR || "out-storia",
  CLOB: process.env.CLOB_API || "https://clob.polymarket.com",
  BLOCCO_BOOK: 40,
};
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
const LOGF = path.join(CFG.OUT_DIR, "log.txt");
function log(...a) {
  const s = new Date().toISOString().slice(11, 19) + " " + a.join(" ");
  console.log(s); fs.appendFileSync(LOGF, s + "\n");
}
async function richiesta(url, opz = {}, tentativi = 4) {
  for (let k = 1; k <= tentativi; k++) {
    try {
      const r = await fetch(url, { ...opz, headers: { accept: "application/json", "content-type": "application/json", ...(opz.headers || {}) } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) { const e = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); e.definitivo = r.status < 500; throw e; }
      return await r.json();
    } catch (e) { if (e.definitivo || k === tentativi) throw e; await sleep(1500 * k); }
  }
}

// ─── premi e book (come xpremi.js) ─────────────────────────────────────────
async function mercatiConPremio() {
  const tutti = []; let cursore = "";
  for (let pagina = 0; pagina < 200; pagina++) {
    const j = await richiesta(`${CFG.CLOB}/rewards/markets/multi?page_size=500${cursore ? `&next_cursor=${encodeURIComponent(cursore)}` : ""}`);
    tutti.push(...(j.data || []));
    if (!j.next_cursor || j.next_cursor === "LTE=" || !(j.data || []).length) break;
    cursore = j.next_cursor;
  }
  return tutti;
}
// premio al giorno attivo in un istante (ms)
function premioIn(m, ms) {
  let tot = 0;
  for (const c of m.rewards_config || []) {
    const inizio = c.start_date ? Date.parse(c.start_date) : 0;
    const fine = c.end_date ? Date.parse(c.end_date) + 86400000 : Infinity;
    if (ms >= inizio && ms <= fine) tot += Number(c.rate_per_day) || 0;
  }
  return tot;
}
async function libri(tokenIds) {
  const mappa = new Map();
  for (let i = 0; i < tokenIds.length; i += CFG.BLOCCO_BOOK) {
    const blocco = tokenIds.slice(i, i + CFG.BLOCCO_BOOK);
    try {
      const j = await richiesta(`${CFG.CLOB}/books`, { method: "POST", body: JSON.stringify(blocco.map((t) => ({ token_id: t }))) });
      for (const b of j || []) {
        const lv = (a) => (a || []).map((x) => [Number(x.price), Number(x.size)]).filter((x) => isFinite(x[0]) && x[1] > 0);
        mappa.set(String(b.asset_id), { bids: lv(b.bids), asks: lv(b.asks), tick: Number(b.tick_size) || 0.01 });
      }
    } catch (e) { log(`[warn] books ${i}: ${e.message}`); }
    await sleep(150);
  }
  return mappa;
}
const S = (v, s) => (s >= v ? 0 : ((v - Math.max(0, s)) / v) ** 2);
const qmin = (q1, q2, medio) => (medio >= 0.10 && medio <= 0.90) ? Math.max(Math.min(q1, q2), Math.max(q1, q2) / 3) : Math.min(q1, q2);
function concorrenza(bY, bN, medio, v) {
  const c = (x) => x * 100;
  let q1 = 0, q2 = 0;
  for (const [p, n] of bY.bids) q1 += S(v, c(medio - p)) * n;
  for (const [p, n] of bN.asks) q1 += S(v, c(p - (1 - medio))) * n;
  for (const [p, n] of bY.asks) q2 += S(v, c(p - medio)) * n;
  for (const [p, n] of bN.bids) q2 += S(v, c((1 - medio) - p)) * n;
  return qmin(q1, q2, medio);
}

// ─── storia dei prezzi: un giorno alla volta a 1 minuto ────────────────────
const GIORNI = { "1d": 1, "1w": 7, "1m": 30 };
let fedelta = 1;   // minuti; se l'API chiede di piu' la alzo
async function storia(tok, nome) {
  const ora = Math.floor(Date.now() / 1000), giorni = GIORNI[CFG.INTERVALLO] || 7;
  const punti = new Map();
  for (let d = giorni - 1; d >= 0; d--) {
    const da = ora - (d + 1) * 86400, a = ora - d * 86400;
    for (let tentativo = 0; tentativo < 3; tentativo++) {
      try {
        const h = await richiesta(`${CFG.CLOB}/prices-history?market=${tok}&startTs=${da}&endTs=${a}&fidelity=${fedelta}`);
        for (const x of h.history || []) {
          const t = Number(x.t) > 1e12 ? Number(x.t) / 1000 : Number(x.t), p = Number(x.p);
          if (isFinite(t) && isFinite(p)) punti.set(t, p);
        }
        break;
      } catch (e) {
        const min = /minimum 'fidelity'.*? is (\d+)/.exec(e.message);
        if (min && Number(min[1]) > fedelta) { fedelta = Number(min[1]); log(`[api] l'API chiede fidelity minima ${fedelta} minuti: la uso`); continue; }
        log(`[warn] storia ${nome}: ${e.message}`); return null;
      }
    }
    await sleep(60);
  }
  return [...punti.entries()].sort((x, y) => x[0] - y[0]);
}

// ─── simulazione su una serie di prezzi ────────────────────────────────────
function simula(m, serie, cand) {
  const { v, tick, qc, minSize } = cand;
  let cassa = 0, pos = 0, premio = 0, esec = 0, minutiQuotati = 0, peggior = 0;
  let netti = 0;   // ordini eseguiti netti: +1 per ogni acquisto di YES, -1 per ogni acquisto di NO (ognuno impegna CAPITALE/2 $)
  for (let i = 0; i + 1 < serie.length; i++) {
    const [t0, p] = serie[i], [t1, pDopo] = serie[i + 1];
    const dtMin = Math.min(60, Math.max(0, (t1 - t0) / 60));
    if (!(p > 0.02 && p < 0.98) || dtMin <= 0) continue;
    const bid = Math.round((Math.ceil(p / tick - 1e-9) * tick - tick) * 10000) / 10000;     // compro YES
    const ask = Math.round((Math.floor(p / tick + 1e-9) * tick + tick) * 10000) / 10000;    // vendo YES (= compro NO)
    const nB = (CFG.CAPITALE / 2) / bid, nA = (CFG.CAPITALE / 2) / (1 - ask);
    const attB = netti < CFG.MAX_POS && nB >= minSize, attA = netti > -CFG.MAX_POS && nA >= minSize;
    // premio per questo intervallo
    const qo = qmin(attB ? S(v, (p - bid) * 100) * nB : 0, attA ? S(v, (ask - p) * 100) * nA : 0, p);
    const rate = premioIn(m, t0 * 1000);
    if (qo > 0 && rate > 0) { premio += rate * (dtMin / 1440) * (qo / (qc + qo)); minutiQuotati += dtMin; }
    // esecuzioni: il prezzo del minuto dopo attraversa l'ordine
    // il prezzo storico e' un prezzo medio: conta come esecuzione solo se lo supera di mezzo tick
    if (attB && pDopo <= bid - tick / 2) { cassa -= bid * nB; pos += nB; esec++; netti++; }
    if (attA && pDopo >= ask + tick / 2) { cassa += ask * nA; pos -= nA; esec++; netti--; }
    const valore = cassa + pos * pDopo;
    if (valore < peggior) peggior = valore;
  }
  const pFine = serie[serie.length - 1][1];
  const trading = cassa + pos * pFine;
  const giorni = (serie[serie.length - 1][0] - serie[0][0]) / 86400;
  return { trading, premio, netto: trading + premio, esec, giorni, minutiQuotati, posFinale: pos, peggior };
}

async function main() {
  log(`══ xstoria · backtest farming premi · capitale ${CFG.CAPITALE} $ · ${CFG.CANDIDATI} candidati · storia ${CFG.INTERVALLO}`);
  const tutti = (await mercatiConPremio()).filter((m) => premioIn(m, Date.now()) > 0);
  log(`[api] mercati con premio attivo: ${tutti.length}`);
  const tokens = [...new Set(tutti.flatMap((m) => (m.tokens || []).slice(0, 2).map((t) => String(t.token_id))))];
  const mappa = await libri(tokens);

  // candidati tranquilli
  const cand = [];
  for (const m of tutti) {
    const yes = m.tokens?.[0], no = m.tokens?.[1];
    const bY = yes && mappa.get(String(yes.token_id)), bN = no && mappa.get(String(no.token_id));
    if (!bY || !bN || !bY.bids.length || !bY.asks.length) continue;
    const bb = Math.max(...bY.bids.map((x) => x[0])), ba = Math.min(...bY.asks.map((x) => x[0]));
    const medio = (bb + ba) / 2;
    let v = Number(m.rewards_max_spread) || 0; if (v > 0 && v < 0.5) v *= 100;
    const giorni = m.end_date ? (Date.parse(m.end_date) - Date.now()) / 86400000 : 999;
    const spread = (ba - bb) * 100;
    if (!(v > 0) || spread > v || medio < 0.15 || medio > 0.85 || giorni < CFG.GIORNI_MIN_FINE) continue;
    const qc = concorrenza(bY, bN, medio, v);
    if (!(qc > 0)) continue;
    const minSize = Number(m.rewards_min_size) || 0;
    const n = (CFG.CAPITALE / 2) / Math.max(medio, 1 - medio);
    if (n < minSize) continue;
    // stima veloce del premio per ordinare i candidati
    const qo = qmin(S(v, 1) * (CFG.CAPITALE / 2) / medio, S(v, 1) * (CFG.CAPITALE / 2) / (1 - medio), medio);
    const stima = premioIn(m, Date.now()) * qo / (qc + qo);
    cand.push({ m, v, tick: bY.tick || 0.01, qc, minSize, medio, giorni, stima });
  }
  cand.sort((a, b) => b.stima - a.stima);
  const scelti = cand.slice(0, CFG.CANDIDATI);
  log(`[filtro] candidati tranquilli: ${cand.length} · simulo i migliori ${scelti.length}`);

  const righe = [];
  let grezzi = 0;
  for (const c of scelti) {
    const tok = String(c.m.tokens[0].token_id);
    const serie = await storia(tok, c.m.market_slug);
    if (!serie) continue;
    if (grezzi < 2) { grezzi++; log(`[api] storia esempio: ${serie.length} punti (fidelity ${fedelta} min), primo ${JSON.stringify(serie[0])}, ultimo ${JSON.stringify(serie[serie.length - 1])}`); }
    if (serie.length < 100) continue;
    const s = simula(c.m, serie, c);
    if (s.giorni < 0.5) continue;
    righe.push({
      domanda: (c.m.question || "").replace(/[\n,;]/g, " ").slice(0, 100), slug: c.m.market_slug,
      giorni: r2(s.giorni), punti: serie.length, esecuzioni: s.esec,
      premio: r2(s.premio), trading: r2(s.trading), netto: r2(s.netto),
      netto_giorno: r4(s.netto / s.giorni), premio_giorno: r4(s.premio / s.giorni), trading_giorno: r4(s.trading / s.giorni),
      peggior_momento: r2(s.peggior), pos_finale: r2(s.posFinale), premio_mercato_oggi: r2(premioIn(c.m, Date.now())), max_spread_c: c.v,
    });
    await sleep(120);
  }
  if (!righe.length) { log("nessuna simulazione riuscita"); process.exit(0); }
  righe.sort((a, b) => b.netto_giorno - a.netto_giorno);
  const col = Object.keys(righe[0]);
  fs.writeFileSync(path.join(CFG.OUT_DIR, "storia.csv"), col.join(",") + "\n" + righe.map((x) => col.map((k) => x[k]).join(",")).join("\n") + "\n");

  const nd = righe.map((x) => x.netto_giorno), m = nd.reduce((a, b) => a + b, 0) / nd.length;
  const sd = Math.sqrt(nd.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, nd.length - 1));
  const sum = (k) => r2(righe.reduce((a, x) => a + x[k], 0));
  const med = (k) => { const a = righe.map((x) => x[k]).sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
  const txt = [
    `xstoria · ${new Date().toISOString().slice(0, 16)} UTC · ${righe.length} mercati simulati · ${CFG.CAPITALE} $ ciascuno · storia ${CFG.INTERVALLO} · prezzi ogni ${fedelta} min`,
    "",
    `TOTALE su tutti i mercati simulati: premio ${sum("premio")} $ · perdite/guadagni da esecuzioni ${sum("trading")} $ · NETTO ${sum("netto")} $`,
    `per mercato al giorno (ogni ${CFG.CAPITALE} $): premio ${r4(righe.reduce((a, x) => a + x.premio_giorno, 0) / righe.length)} · esecuzioni ${r4(righe.reduce((a, x) => a + x.trading_giorno, 0) / righe.length)} · netto ${r4(m)}`,
    `netto al giorno mediano ${med("netto_giorno")} · mercati in attivo ${righe.filter((x) => x.netto > 0).length}/${righe.length} · t ${r2(m / (sd / Math.sqrt(nd.length)))} (|t|>2 = non e' fortuna)`,
    `peggior momento medio (perdita massima a meta' strada) ${r2(righe.reduce((a, x) => a + x.peggior_momento, 0) / righe.length)} $ per mercato`,
    "",
    "MIGLIORI 20 (netto al giorno per " + CFG.CAPITALE + " $):",
    ...righe.slice(0, 20).map((x, i) => `${String(i + 1).padStart(3)}. netto ${String(x.netto_giorno).padStart(8)} $/g · premio ${x.premio_giorno} · esecuzioni ${x.trading_giorno} (${x.esecuzioni}) · ${x.domanda}`),
    "",
    "PEGGIORI 10:",
    ...righe.slice(-10).map((x) => `     netto ${String(x.netto_giorno).padStart(8)} $/g · premio ${x.premio_giorno} · esecuzioni ${x.trading_giorno} (${x.esecuzioni}) · ${x.domanda}`),
    "",
    "LIMITI: la concorrenza e' quella di una sola fotografia; il bot simulato si aggiorna ogni minuto ed e'",
    "sempre primo in coda (ottimista); contano solo le esecuzioni in cui il prezzo attraversa l'ordine",
    "(prudente). Nei trend lenti il bot simulato si sposta ogni minuto e non viene mai preso:",
    "nella realta' una parte di quei movimenti avviene proprio comprando i tuoi ordini (ottimista).",
    "I mercati sono scelti tra quelli con il premio stimato piu' alto OGGI.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(CFG.OUT_DIR, "riepilogo.txt"), txt);
  log("\n" + txt);
}
if (!process.env.XSTORIA_NO_MAIN) main().catch((e) => { log("[fatale]", e.stack || e.message); process.exit(1); });
export { simula, premioIn, S, qmin, CFG };
