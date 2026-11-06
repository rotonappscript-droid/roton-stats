# Roton Stats (app)

The weekly international stats app for Roton Music. Static site on GitHub Pages; all numbers live in the private
`roton-stats-data` repository and are read and written through the GitHub API with each person's own token.

- `index.html`, `app.js`, `styles.css`: the app (no build step).
- `store.js`: GitHub storage (one commit per save) and the preview store.
- `engine/rules.js`: every report rule from the Apps Script app, ported verbatim. Same file runs in the browser and in Actions.
- `engine/songstats.js`: Songstats API data mapped onto the sections the rules expect.
- `engine/build.js`: builds one report week from Songstats + Spotify for Artists + Radiomonitor.
- `engine/contacts.js`: reads the "Contacte radio internationale - Lista globala" workbook.

Publishing: Settings › Pages › Source: GitHub Actions. Every push to `main` republishes.
