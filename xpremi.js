// ═══════════════════════════════════════════════════════════════════════════
// xpremi.js — SCANNER dei premi di liquidita' di Polymarket (SOLO LETTURA)
//
// Non piazza ordini, non usa chiavi. Legge:
//   GET  https://clob.polymarket.com/rewards/markets/multi   tutti i mercati con premio
//   POST https://clob.polymarket.com/books                   i book, a blocchi
//
// Per ogni mercato con premio stima: se mettessi CAPITALE $ di ordini limite
// (meta' su YES, meta' su NO, a 1 tick dal prezzo medio), quanto premio
// prenderei al giorno, data la liquidita' che c'e' gia'.
//
// Formula ufficiale (docs Polymarket, Liquidity Rewards):
//   S(v,s) = ((v - s) / v)^2           v = distanza massima (cent), s = distanza dell'ordine
//   Q_one  = S·bid su YES + S·ask su NO
//   Q_two  = S·ask su YES + S·bid su NO
//   Q_min  = max(min(Q_one,Q_two), max(Q_one,Q_two)/3)   se il medio e' tra 0,10 e 0,90
//          = min(Q_one,Q_two)                             altrimenti (solo chi sta su 2 lati)
//   premio = premio_giorno × (mio Q_min / Q_min di tutti)
//
// LIMITI DELLA STIMA (da leggere prima di credere ai numeri):
//   - il book mostra livelli di prezzo, non i singoli ordini: non posso escludere gli
//     ordini sotto la quantita' minima, quindi la concorrenza e' un po' sovrastimata
//     (stima prudente per noi);
//   - il book cambia di continuo: faccio piu' fotografie e uso la media;
//   - NON stima le perdite: se arriva una notizia, i tuoi ordini vengono presi al
//     prezzo vecchio. Le colonne di rischio servono a giudicare questo.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";

const CFG = {
  CAPITALE: Number(process.env.CAPITALE || 100),      // $ per mercato, divisi a meta' sui due lati
  FOTO: Number(process.env.FOTO || 3),                // quante fotografie del book
  PAUSA_MIN: Number(process.env.PAUSA_MIN || 10),     // minuti tra una fotografia e l'altra
  BLOCCO_BOOK: 40,                                    // token per richiesta /books
  OUT_DIR: process.env.OUT_DIR || "out-premi",
  CLOB: process.env.CLOB_API || "https://clob.polymarket.com",
  TOP: 40,
};

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
const LOGF = path.join(CFG.OUT_DIR, "log.txt");
function log(...a) {
  const s = new Date().toISOString().slice(11, 19) + " " + a.join(" ");
  console.log(s);
  fs.appendFileSync(LOGF, s + "\n");
}
async function richiesta(url, opz = {}, tentativi = 4) {
  for (let k = 1; k <= tentativi; k++) {
    try {
      const r = await fetch(url, { ...opz, headers: { accept: "application/json", "content-type": "application/json", ...(opz.headers || {}) } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    } catch (e) {
      if (k === tentativi) throw e;
      await sleep(1500 * k);
    }
  }
}

// ─── 1) tutti i mercati con premio ─────────────────────────────────────────
async function mercatiConPremio() {
  const tutti = [];
  let cursore = "";
  for (let pagina = 0; pagina < 200; pagina++) {
    const url = `${CFG.CLOB}/rewards/markets/multi?page_size=500${cursore ? `&next_cursor=${encodeURIComponent(cursore)}` : ""}`;
    const j = await richiesta(url);
    if (pagina === 0) log(`[api] prima pagina: count ${j.count} · esempio ${JSON.stringify(j.data?.[0] ?? {}).slice(0, 400)}`);
    tutti.push(...(j.data || []));
    if (!j.next_cursor || j.next_cursor === "LTE=" || !(j.data || []).length) break;
    cursore = j.next_cursor;
  }
  return tutti;
}

function premioAlGiorno(m) {
  const oggi = Date.now();
  let tot = 0;
  for (const c of m.rewards_config || []) {
    const inizio = c.start_date ? Date.parse(c.start_date) : 0;
    const fine = c.end_date ? Date.parse(c.end_date) + 86400000 : Infinity;
    if (oggi >= inizio && oggi <= fine) tot += Number(c.rate_per_day) || 0;
  }
  return tot;
}

// ─── 2) book a blocchi ─────────────────────────────────────────────────────
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
    } catch (e) { log(`[warn] books blocco ${i}: ${e.message}`); }
    await sleep(150);
  }
  return mappa;
}

// ─── 3) punteggio ufficiale ────────────────────────────────────────────────
const S = (v, s) => (s >= v ? 0 : ((v - s) / v) ** 2);
function punteggio(bYes, bNo, medio, v) {
  // v e s in centesimi; il medio di NO e' 1 - medio
  const cent = (x) => x * 100;
  let q1 = 0, q2 = 0;
  for (const [p, n] of bYes.bids) q1 += S(v, cent(medio - p)) * n;
  for (const [p, n] of bNo.asks) q1 += S(v, cent(p - (1 - medio))) * n;
  for (const [p, n] of bYes.asks) q2 += S(v, cent(p - medio)) * n;
  for (const [p, n] of bNo.bids) q2 += S(v, cent((1 - medio) - p)) * n;
  return { q1, q2 };
}
const qmin = (q1, q2, medio) => (medio >= 0.10 && medio <= 0.90) ? Math.max(Math.min(q1, q2), Math.max(q1, q2) / 3) : Math.min(q1, q2);

function analizza(m, mappa) {
  const yes = m.tokens?.[0], no = m.tokens?.[1];
  if (!yes || !no) return null;
  const bY = mappa.get(String(yes.token_id)), bN = mappa.get(String(no.token_id));
  if (!bY || !bN) return null;
  const bestBid = Math.max(0, ...bY.bids.map((x) => x[0]));
  const bestAsk = Math.min(1, ...bY.asks.map((x) => x[0]));
  if (!(bestBid > 0 && bestAsk < 1 && bestAsk > bestBid)) return null;
  const medio = (bestBid + bestAsk) / 2;
  let v = Number(m.rewards_max_spread) || 0;
  if (v > 0 && v < 0.5) v *= 100;                     // se arriva in prezzo invece che in cent
  if (!(v > 0)) return null;
  const minSize = Number(m.rewards_min_size) || 0;
  const tick = bY.tick || 0.01;
  const { q1, q2 } = punteggio(bY, bN, medio, v);
  const qTot = qmin(q1, q2, medio);

  // la mia offerta: un bid su YES e un bid su NO, al tick sotto il medio (senza attraversare il book)
  // il prezzo piu' alto sul tick che non supera il medio e non attraversa il book
  const prezzoBid = (med, asks) => {
    const ask = Math.min(1, ...asks.map((x) => x[0]));
    let p = Math.floor((med + 1e-9) / tick) * tick;
    if (p >= ask - 1e-9) p = ask - tick;
    return Math.round(p * 10000) / 10000;
  };
  const medioNo = 1 - medio;
  const pYes = prezzoBid(medio, bY.asks), pNo = prezzoBid(medioNo, bN.asks);
  if (!(pYes > 0 && pNo > 0)) return null;
  const sYes = (medio - pYes) * 100, sNo = (medioNo - pNo) * 100;
  const nYes = (CFG.CAPITALE / 2) / pYes, nNo = (CFG.CAPITALE / 2) / pNo;
  const capMin = r2(minSize * pYes + minSize * pNo);
  const sottoMinimo = nYes < minSize || nNo < minSize;
  const mio = sottoMinimo ? 0 : qmin(S(v, sYes) * nYes, S(v, sNo) * nNo, medio);
  const premio = premioAlGiorno(m);
  const quota = mio > 0 ? mio / (qTot + mio) : 0;
  const alGiorno = premio * quota;
  const giorni = m.end_date ? (Date.parse(m.end_date) - Date.now()) / 86400000 : null;
  return {
    domanda: (m.question || "").replace(/[\n,;]/g, " ").slice(0, 110),
    slug: m.market_slug || m.event_slug || m.condition_id,
    premio_giorno: r2(premio), max_spread_c: r2(v), min_size: minSize, medio: r4(medio),
    spread_c: r2((bestAsk - bestBid) * 100), concorrenza_Q: Math.round(qTot), mio_Q: Math.round(mio),
    quota_pct: r2(100 * quota), premio_mio_giorno: r4(alGiorno),
    rendimento_giorno_pct: r4(100 * alGiorno / CFG.CAPITALE),
    capitale_minimo: capMin, sotto_minimo: sottoMinimo ? "SI" : "",
    volume_24h: r2(Number(m.volume_24hr) || 0), variazione_1g: r4(Number(m.one_day_price_change) || 0),
    giorni_alla_fine: giorni === null ? "" : r2(giorni),
  };
}

function rischio(x) {
  // indicatori grezzi: piu' alto = piu' pericoloso per chi tiene ordini fermi
  let s = 0;
  if (Math.abs(x.variazione_1g) >= 0.10) s += 2; else if (Math.abs(x.variazione_1g) >= 0.03) s += 1;
  if (x.giorni_alla_fine !== "" && x.giorni_alla_fine < 2) s += 2; else if (x.giorni_alla_fine !== "" && x.giorni_alla_fine < 7) s += 1;
  if (x.volume_24h > 50000) s += 1;
  if (x.medio < 0.10 || x.medio > 0.90) s += 1;
  return s <= 1 ? "basso" : s <= 3 ? "medio" : "alto";
}

async function main() {
  log(`══ xpremi · scanner premi di liquidita' · capitale ${CFG.CAPITALE} $ per mercato · ${CFG.FOTO} fotografie ogni ${CFG.PAUSA_MIN} min`);
  const mercati = (await mercatiConPremio()).filter((m) => premioAlGiorno(m) > 0);
  log(`[api] mercati con premio attivo: ${mercati.length} · premio totale ${r2(mercati.reduce((s, m) => s + premioAlGiorno(m), 0))} $/giorno`);
  const tokens = [...new Set(mercati.flatMap((m) => (m.tokens || []).slice(0, 2).map((t) => String(t.token_id))))];

  const somme = new Map();   // slug -> {x, n, sommaQuota, sommaPremio, sommaConc}
  for (let f = 1; f <= CFG.FOTO; f++) {
    log(`[foto ${f}/${CFG.FOTO}] leggo ${tokens.length} book...`);
    const mappa = await libri(tokens);
    let ok = 0;
    for (const m of mercati) {
      const x = analizza(m, mappa);
      if (!x) continue;
      ok++;
      const s = somme.get(x.slug) ?? { x, n: 0, quota: 0, premio: 0, conc: 0 };
      s.x = x; s.n++; s.quota += x.quota_pct; s.premio += x.premio_mio_giorno; s.conc += x.concorrenza_Q;
      somme.set(x.slug, s);
    }
    log(`[foto ${f}] mercati analizzati ${ok}/${mercati.length}`);
    if (f < CFG.FOTO) await sleep(CFG.PAUSA_MIN * 60000);
  }

  const righe = [...somme.values()].map((s) => {
    const x = { ...s.x, quota_pct: r2(s.quota / s.n), premio_mio_giorno: r4(s.premio / s.n), concorrenza_Q: Math.round(s.conc / s.n), foto: s.n };
    x.rendimento_giorno_pct = r4(100 * x.premio_mio_giorno / CFG.CAPITALE);
    x.rendimento_anno_pct = r2(365 * x.rendimento_giorno_pct);
    x.rischio = rischio(x);
    return x;
  }).sort((a, b) => b.premio_mio_giorno - a.premio_mio_giorno);

  if (!righe.length) { log("nessun mercato analizzabile"); process.exit(0); }
  const col = Object.keys(righe[0]);
  fs.writeFileSync(path.join(CFG.OUT_DIR, "premi.csv"), col.join(",") + "\n" + righe.map((x) => col.map((k) => x[k]).join(",")).join("\n") + "\n");

  const utili = righe.filter((x) => x.sotto_minimo !== "SI");
  const somma = (arr) => r2(arr.reduce((s, x) => s + x.premio_mio_giorno, 0));
  const top = utili.slice(0, CFG.TOP);
  const bassi = utili.filter((x) => x.rischio === "basso");
  const txt = [
    `xpremi · ${new Date().toISOString().slice(0, 16)} UTC · capitale ${CFG.CAPITALE} $ per mercato (meta' YES, meta' NO, 1 tick dal medio)`,
    `mercati con premio: ${mercati.length} · analizzati: ${righe.length} · con capitale sufficiente per il minimo: ${utili.length}`,
    `premio totale offerto da Polymarket: ${r2(mercati.reduce((s, m) => s + premioAlGiorno(m), 0))} $/giorno`,
    "",
    `SE METTESSI ${CFG.CAPITALE} $ IN OGNUNO DEI MIGLIORI (stima lorda, SENZA perdite da ordini presi):`,
    `  migliori 10: ${somma(utili.slice(0, 10))} $/giorno su ${10 * CFG.CAPITALE} $ impegnati`,
    `  migliori 40: ${somma(top)} $/giorno su ${top.length * CFG.CAPITALE} $ impegnati`,
    `  solo rischio basso (${bassi.length} mercati): migliori 10 → ${somma(bassi.slice(0, 10))} $/giorno`,
    "",
    `MIGLIORI ${top.length} (premio stimato al giorno per ${CFG.CAPITALE} $):`,
    ...top.map((x, i) => `${String(i + 1).padStart(3)}. ${String(x.premio_mio_giorno).padStart(7)} $/g (${String(x.rendimento_giorno_pct).padStart(6)}%/g) · quota ${String(x.quota_pct).padStart(6)}% · premio mercato ${x.premio_giorno} $/g · medio ${x.medio} · rischio ${x.rischio} · fine ${x.giorni_alla_fine} gg · ${x.domanda}`),
    "",
    "LEGGERE CON CAUTELA: i numeri non includono le perdite quando una notizia fa scattare il prezzo",
    "e i tuoi ordini vengono presi al prezzo vecchio. Su mercati con rischio medio/alto possono",
    "superare il premio. Il premio si divide tra tutti i maker e cambia di giorno in giorno.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(CFG.OUT_DIR, "riepilogo.txt"), txt);
  log("\n" + txt);
}
if (!process.env.XPREMI_NO_MAIN) main().catch((e) => { log("[fatale]", e.stack || e.message); process.exit(1); });
export { punteggio, qmin, analizza, premioAlGiorno, S, CFG };
