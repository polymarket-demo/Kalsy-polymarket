async function preparaAuth(cli) {
  const nomi = [
    "createOrDeriveApiCreds",
    "deriveApiCreds",
    "deriveApiKey",
    "createApiKey",
    "setApiCreds",
  ];
  for (const nome of nomi) {
    if (typeof cli[nome] === "function") {
      try {
        await cli[nome]();
        console.log(`[auth] credenziali derivate con ${nome}()`);
        return;
      } catch (e) {
        console.log(`[auth] ${nome}() fallito: ${e.message}`);
      }
    }
  }
  console.log("[auth] nessun derivatore trovato — procedo con la sola firma del wallet");
}
