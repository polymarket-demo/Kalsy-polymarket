  const w0 = new ethers.Wallet(process.env.PRIVATE_KEY);
  console.log(`firmatario: ${w0.address}`);
  const tmp = new ClobClient(CLOB, CHAIN, w0);

  const nomiGen = ["createApiKey", "createOrDeriveApiCreds", "deriveApiKey"];
  for (const n of nomiGen) {
    if (typeof tmp[n] === "function") {
      try {
        const c = await tmp[n]();
        console.log("════ CREDENZIALI ════");
        console.log(`KEY=${c.key}`);
        console.log(`SECRET=${c.secret}`);
        console.log(`PASSPHRASE=${c.passphrase}`);
        console.log("═════════════════════");
        return;   // ← STOP
      } catch (e) {
        console.log(`${n}() fallito: ${e.message}`);
      }
    }
  }
