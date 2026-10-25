name: xmaker

on:
  workflow_dispatch:
    inputs:
      rounds:
        description: "Numero di round (max ~60)"
        default: "30"
      difesa:
        description: "Difesa anti fill tossico (1 = sì, 0 = no)"
        default: "1"

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 350
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Avvia bot maker
        env:
          ROUNDS: ${{ github.event.inputs.rounds }}
          DIFESA: ${{ github.event.inputs.difesa }}
        run: node maker/xmaker.js
      - name: Salva risultati
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: out-mk
          path: out-mk/
