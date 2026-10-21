// ═══════════════════════════════════════════════════════════════════════════
// xsignal.js — MISURA + SEGNALI (NESSUN ORDINE, SOLO DATI)
// ═══════════════════════════════════════════════════════════════════════════
//
// REGOLA MISURATA SUI DATI (non stimata):
//   quota 0,44 su UP e DN (5 share = 2,20 $ per lato, coppia 4,40 $)
//   coppia chiusa  -> 5,00 incassati -> +0,60 $
//   stop a 0,35    -> -0,45 $
//
//   NON si aspetta un tempo fisso: si aspetta finche' il LATO COMPRATO
//   resta >= 0,35. In pratica decide a 25-30 secondi.
//   A quel punto:
//     perdente < 0,35  E  vincente <= 0,70  ->  ROTAZIONE
//     altrimenti                            ->  STOP a 0,35
//
// Test sui dati (4 round a un lato): stop -1,80 $ vs rotazione +4,55/+5,60 $.
//
// NON piazza ordini. Non usa chiavi private. Non tocca l'API di trading.

import WebSocket from "ws";
import fs from "fs";
import path from "path";

const CFG = {
  QUOTA: 0.44,            // quota base su UP e DN
  SHARES: 5,              // share per lato
  STOP: 0.35,             // stop sul lato scoperto
  SOGLIA_PERDENTE: 0.35,  // aspetti finche' il lato comprato sta sopra questo
  TETTO_VINCENTE: 0.70,   // ruota solo se il vincente e' <= questo
  MAX_ATTESA_S: 120,      // rete di sicurezza: oltre questo, decidi comunque
  SIGLIA_TICK: 0.47,      // soglia per il conteggio "size sotto"
  POLL_MS: 1000,
  OUT_DIR: "out",
};

const COSTO_LATO    = CFG.QUOTA * CFG.SHARES;              // 2.20
const COSTO_COPPIA  = COSTO_LATO * 2;                      // 4.40
const INCASSO_COPPIA = CFG.SHARES * 1.0;                   // 5.00
const PROFITTO_COPPIA = INCASSO_COPPIA - COSTO_COPPIA;     // +0.60
const PERDITA_STOP = (CFG.STOP - CFG.QUOTA) * CFG.SHARES;  // -0.45

const GAMMA = process.env.GAMMA_API || "https://gamma-api.polymarket.com";
const CLOB  = process.env.CLOB_API  || "https://clob.polymarket.com";
const WINDOW = 300;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jget(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function roundStart(now = Date.now()) {
  return Math.floor(now / 1000 / WINDOW) * WINDOW;
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
    return {
      slug, title: ev[0].title, conditionId: m.conditionId,
      upToken: tokens?.[0] ?? null, dnToken: tokens?.[1] ?? null,
    };
  } catch (e) {
    log("[warn] gamma:", e.message);
    return null;
  }
}

class BookReader {
  constructor(tokens) { this.tokens = tokens; this.books = new Map(); this.ws = null; }

  start() {
    try {
      this.ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
      this.ws.on("open", () => {
        this.ws.send(JSON.stringify({ type: "subscribe", channel: "book", assets_ids: this.tokens }));
        log("[ws] connesso, sottoscritto book");
      });
      this.ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          for (const m of (Array.isArray(msg) ? msg : [msg])) {
            if (m.type === "book" || m.event_type === "book") {
              const id = m.asset_id || m.market;
              if (!id) continue;
              this.books.set(id, {
                bids: (m.bids || m.buys || []).map((b) => [parseFloat(b.price), parseFloat(b.size)]),
                asks: (m.asks || m.sells || []).map((a) => [parseFloat(a.price), parseFloat(a.size)]),
              });
            }
          }
        } catch (_) {}
      });
      this.ws.on("close", () => log("[ws] chiuso, uso REST"));
      this.ws.on("error", () => {});
    } catch (e) { log("[ws] errore:", e.message); }
  }

  stop() { try { this.ws?.close(); } catch (_) {} }

  async leggi(tokenId) {
    if (!tokenId) return null;
    let b = this.books.get(tokenId);
    if (!b || (!b.bids.length && !b.asks.length)) {
      try {
        const r = await jget(`${CLOB}/book?token_id=${tokenId}`);
        b = {
          bids: (r.bids || []).map((x) => [parseFloat(x.price), parseFloat(x.size)]),
          asks: (r.asks || []).map((x) => [parseFloat(x.price), parseFloat(x.size)]),
        };
        this.books.set(tokenId, b);
      } catch (_) { return null; }
    }
    const bids = (b.bids || []).filter((x) => isFinite(x[0]) && isFinite(x[1]));
    const asks = (b.asks || []).filter((x) => isFinite(x[0]) && isFinite(x[1]));
    const bestBid = bids.length ? Math.max(...bids.map((x) => x[0])) : null;
    const bestAsk = asks.length ? Math.min(...asks.map((x) => x[0])) : null;
    const sizeSotto = asks.filter((x) => x[0] <= CFG.SIGLIA_TICK).reduce((s, x) => s + x[1], 0);
    return { bestBid, bestAsk, sizeSotto };
  }
}

async function supaInvia(righe) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false;
  try {
    const r = await fetch(`${url}/rest/v1/xsignals`, {
      method: "POST",
      headers: { apikey: key, authorization: `Bearer ${key}`,
                 "content-type": "application/json", prefer: "return=minimal" },
      body: JSON.stringify(righe),
    });
    if (!r.ok) log("[supa] errore", r.status, await r.text());
    return r.ok;
  } catch (e) { log("[supa] errore:", e.message); return false; }
}

async function eseguiRound(r) {
  log(`\n${"=".repeat(70)}`);
  log(`ROUND ${r.slug} | ${r.title}`);

  const reader = new BookReader([r.upToken, r.dnToken].filter(Boolean));
  reader.start();

  const inizio = roundStart();
  const tick = [];
  let firstUp = null, firstDn = null, winUp = 0, winDn = 0;
  let decisione = null, deciso = false;

  while (Math.floor(Date.now() / 1000) - inizio < WINDOW) {
    const t = (Date.now() - inizio * 1000) / 1000;
    const rem = WINDOW - t;
    const [up, dn] = await Promise.all([reader.leggi(r.upToken), reader.leggi(r.dnToken)]);
    if (!up || !dn) { await sleep(CFG.POLL_MS); continue; }

    const u = up.bestAsk, d = dn.bestAsk;
    tick.push({ t: +t.toFixed(1), up: u, dn: d, sUp: up.sizeSotto, sDn: dn.sizeSotto });

    if (u !== null && u > winUp) winUp = u;
    if (d !== null && d > winDn) winDn = d;
    if (firstUp === null && u !== null && u <= CFG.QUOTA) firstUp = +t.toFixed(1);
    if (firstDn === null && d !== null && d <= CFG.QUOTA) firstDn = +t.toFixed(1);

    // ── COPPIA: entrambi dentro ──────────────────────────────────────────
    if (firstUp !== null && firstDn !== null && !decisione) {
      decisione = { tipo: "COPPIA", a_secondi: +t.toFixed(1) };
      log(`[SEGNALE] COPPIA chiusa @${t.toFixed(1)}s -> +${PROFITTO_COPPIA.toFixed(2)} $`);
    }

    // ── DECISIONE: quando il lato comprato scende sotto SOGLIA_PERDENTE ──
    if (!decisione && !deciso) {
      const dentroUp = firstUp !== null, dentroDn = firstDn !== null;
      if (dentroUp !== dentroDn) {
        const comprato = dentroUp ? "UP" : "DN";
        const mancato  = dentroUp ? "DN" : "UP";
        const pComp = dentroUp ? u : d;      // prezzo del lato COMPRATO
        const pManc = dentroUp ? d : u;      // prezzo del lato MANCATO (probabile vincente)
        const scaduto = t >= CFG.MAX_ATTESA_S;

        if ((pComp !== null && pComp < CFG.SOGLIA_PERDENTE) || scaduto) {
          const ruota = (pComp < CFG.SOGLIA_PERDENTE) &&
                        (pManc !== null && pManc <= CFG.TETTO_VINCENTE);
          decisione = {
            tipo: ruota ? "ROTAZIONE" : "STOP",
            a_secondi: +t.toFixed(1),
            comprato, mancato,
            prezzo_perdente: pComp,
            prezzo_vincente: pManc,
            perche: ruota ? "perdente sotto soglia, vincente ancora a sconto"
                          : "condizioni non favorevoli alla rotazione",
          };
          if (ruota) {
            const rot = (INCASSO_COPPIA + pComp * CFG.SHARES) - (CFG.QUOTA * CFG.SHARES + pManc * CFG.SHARES);
            decisione.pnl_rotazione = +rot.toFixed(3);
            log(`[SEGNALE] ROTAZIONE @${t.toFixed(1)}s: vendi ${comprato}@${pComp}, compra ${mancato}@${pManc} -> ${rot >= 0 ? "+" : ""}${rot.toFixed(2)} $`);
          } else {
            decisione.pnl_stop = PERDITA_STOP;
            log(`[SEGNALE] STOP @${t.toFixed(1)}s: ${comprato} a ${pComp}, vincente ${mancato}@${pManc} -> -${Math.abs(PERDITA_STOP).toFixed(2)} $`);
          }
          deciso = true;
        }
      }
    }

    if (Math.floor(t) % 30 === 0 && Math.abs(t - Math.round(t)) < 0.6) {
      log(`  t=${t.toFixed(0)}s rem=${rem.toFixed(1)}' | UP ${u} (s47 ${Math.round(up.sizeSotto)}) | DN ${d} (s47 ${Math.round(dn.sizeSotto)})`);
    }
    await sleep(CFG.POLL_MS);
  }

  reader.stop();

  const upMin = Math.min(...tick.map((x) => x.up ?? 9));
  const dnMin = Math.min(...tick.map((x) => x.dn ?? 9));
  const coppia = upMin <= CFG.QUOTA && dnMin <= CFG.QUOTA;
  const esito = coppia ? "COPPIA" : "UN_LATO";

  let pnl;
  if (coppia) pnl = PROFITTO_COPPIA;
  else if (decisione && decisione.tipo === "ROTAZIONE") pnl = decisione.pnl_rotazione;
  else pnl = PERDITA_STOP;

  log(`>>> ROUND ${r.slug}`);
  log(`    letture ok: ${tick.length} | esito: ${esito} | decisione: ${decisione ? decisione.tipo : "nessuna"}`);
  log(`    UP min: ${upMin} | DN min: ${dnMin}`);
  log(`    SIZE MAX sotto 0,47: UP ${Math.round(winUp)} | DN ${Math.round(winDn)}`);
  if (decisione && decisione.a_secondi) {
    log(`    DECISIONE @${decisione.a_secondi}s | perdente ${decisione.prezzo_perdente} | vincente ${decisione.prezzo_vincente}`);
  }
  log(`    PnL stimato: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} $`);

  const riga = {
    slug: r.slug, round_start: inizio,
    ora_et: new Date(inizio * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }),
    esito, decisione: decisione ? decisione.tipo : null,
    decisione_secondi: decisione?.a_secondi ?? null,
    quota: CFG.QUOTA, up_min: upMin, dn_min: dnMin,
    first_up: firstUp, first_dn: firstDn,
    size_max_up47: Math.round(winUp), size_max_dn47: Math.round(winDn),
    prezzo_perdente: decisione?.prezzo_perdente ?? null,
    prezzo_vincente: decisione?.prezzo_vincente ?? null,
    pnl, letture: tick.length,
  };

  await supaInvia([riga]);

  fs.mkdirSync(CFG.OUT_DIR, { recursive: true });
  fs.appendFileSync(path.join(CFG.OUT_DIR, "rounds.csv"),
    [r.slug, inizio, esito, decisione ? decisione.tipo : "", decisione?.a_secondi ?? "",
     upMin, dnMin, firstUp ?? "", firstDn ?? "", Math.round(winUp), Math.round(winDn), pnl].join(",") + "\n");
  fs.writeFileSync(path.join(CFG.OUT_DIR, `${r.slug}.csv`),
    "t,up,dn,size_under_up,size_under_dn\n" +
    tick.map((x) => [x.t, x.up ?? "", x.dn ?? "", Math.round(x.sUp), Math.round(x.sDn)].join(",")).join("\n"));

  return riga;
}

async function main() {
  log("═══════════════════════════════════════════════════════");
  log("  xsignal — MISURA + SEGNALI (nessun ordine)");
  log("═══════════════════════════════════════════════════════");
  log(`  quota ${CFG.QUOTA} | coppia ${COSTO_COPPIA.toFixed(2)} $ -> +${PROFITTO_COPPIA.toFixed(2)} $`);
  log(`  stop ${CFG.STOP} (-${Math.abs(PERDITA_STOP).toFixed(2)} $)`);
  log(`  REGOLA: aspetti finche' il lato comprato >= ${CFG.SOGLIA_PERDENTE}`);
  log(`          sotto ${CFG.SOGLIA_PERDENTE} e vincente <= ${CFG.TETTO_VINCENTE} -> ROTAZIONE`);
  log(`          altrimenti -> STOP`);
  log("═══════════════════════════════════════════════════════");

  while (true) {
    const start = roundStart();
    const r = await trovaRound(start);
    if (!r || !r.upToken || !r.dnToken) {
      log(`[wait] round ${start} non trovato, riprovo...`);
      await sleep(15000);
      continue;
    }
    try { await eseguiRound(r); } catch (e) { log("[err]", e.message); }
    const attesa = Math.max(1000, (start + WINDOW) * 1000 - Date.now() + 2000);
    log(`[wait] prossimo round fra ${(attesa / 1000).toFixed(0)}s`);
    await sleep(attesa);
  }
}

process.on("SIGINT", () => { log("stop"); process.exit(0); });
main().catch((e) => { console.error(e); process.exit(1); });
