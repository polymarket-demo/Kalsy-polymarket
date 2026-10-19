// ═══════════════════════════════════════════════════════════════════════════
// xsignal.js — BOT DI MISURA + SEGNALI (NESSUN ORDINE, SOLO DATI)
// ═══════════════════════════════════════════════════════════════════════════
//
// Cosa fa, ogni round BTC 5m:
//   1. Legge il book UP/DN ogni secondo (WebSocket + REST fallback)
//   2. Segna il TICK di ogni lato e la SIZE disponibile sotto 0,47
//   3. SEGNALA tre cose studiate sui dati:
//        [COPPIA]    entrambi i lati sono passati sotto 0,44  -> +0,60 $
//        [ROTAZIONE] un solo lato riempito e il vincente <= 0,70 a 30 s
//        [STOP]      un solo lato e il vincente > 0,70  -> stop a 0,35 (-0,45 $)
//   4. Scrive tutto su Supabase (tabella xsignals) + CSV locale
//
// NON piazza ordini. Non usa chiavi private. Non tocca l'API di trading.

import WebSocket from "ws";
import fs from "fs";
import path from "path";

const CFG = {
  QUOTA: 0.44,
  SHARES: 5,
  STOP: 0.35,
  ROTATE_AT_S: 30,
  ROTATE_MAX_PRICE: 0.70,
  SIGLIA_TICK: 0.47,
  POLL_MS: 1000,
  OUT_DIR: "out",
};

const COSTO_LATO = CFG.QUOTA * CFG.SHARES;
const COSTO_COPPIA = COSTO_LATO * 2;
const INCASSO_COPPIA = CFG.SHARES * 1.0;
const PROFITTO_COPPIA = INCASSO_COPPIA - COSTO_COPPIA;
const PERDITA_STOP = (CFG.QUOTA - CFG.STOP) * CFG.SHARES;

const GAMMA = process.env.GAMMA_API || "[https://gamma-api.polymarket.com";](https://gamma-api.polymarket.com";)
const CLOB = process.env.CLOB_API || "[https://clob.polymarket.com";](https://clob.polymarket.com";)
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
      slug,
      title: ev[0].title,
      conditionId: m.conditionId,
      upToken: tokens?.[0] ?? null,
      dnToken: tokens?.[1] ?? null,
    };
  } catch (e) {
    log("[warn] gamma:", e.message);
    return null;
  }
}

class BookReader {
  constructor(tokens) {
    this.tokens = tokens;
    this.books = new Map();
    this.ws = null;
  }

  start() {
    try {
      this.ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
      this.ws.on("open", () => {
        this.ws.send(JSON.stringify({
          type: "subscribe", channel: "book", assets_ids: this.tokens,
        }));
        log("[ws] connesso, sottoscritto book");
      });
      this.ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const arr = Array.isArray(msg) ? msg : [msg];
          for (const m of arr) {
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
      this
      
