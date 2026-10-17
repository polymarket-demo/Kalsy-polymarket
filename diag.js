const chiavi = ["PRIVATE_KEY","POLY_API_KEY","POLY_API_SECRET","POLY_API_PASSPHRASE","POLYMARKET_FUNDER","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY"];
console.log("════ VARIABILI ARRIVATE ════");
for (const k of chiavi) {
  const v = process.env[k];
  console.log(`${k}: ${v ? "PRESENTE len=" + v.length + " inizio=" + v.slice(0,6) : "MANCANTE"}`);
}
