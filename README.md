# cerca-web

A browser-only reference checker. Paste a list of bibliographic references; each one is queried against Crossref, OpenAlex, Zenodo, and Semantic Scholar and given a match score.

## Relation to upstream

This is a **JavaScript port of [CERCA](https://github.com/lidianycs/cerca)** by Lidiany Cerqueira, licensed under AGPL-3.0. The original is a JavaFX desktop application that uses the CERMINE Java library to extract references from PDFs.

### Modifications from upstream

- Ported from Java/JavaFX to plain HTML + JavaScript (no build step, no framework).
- **PDF extraction removed.** CERMINE has no JavaScript equivalent; input is via copy-paste only.
- Reference parsing uses a browser port of the [AnyStyle](https://github.com/inukshuk/anystyle) CRF parser, with a heuristic fallback if the model fails to load.
- Added a heuristic line-joiner that reassembles references wrapped across multiple lines by PDF copy-paste, supporting APA, MLA, Harvard, Vancouver, IEEE, and corporate-author styles.
- API calls go directly from the browser to the four academic services. There is no backend; the site is served as static files from Azure Blob Storage.
- Concurrency: 3 references verified in parallel. Zenodo and Semantic Scholar fallbacks are rate-limited to 1 request/second each to respect their stricter quotas.
- Match-merge behaviour: the highest-scoring result across providers wins, rather than the last one returned (upstream overwrites unconditionally).
- DOI column split into "Parsed DOI" (extracted from the user's input) and "Matched DOI" (returned by the API) to avoid confusion on FAIL rows.
- Settings (polite-pool email, Semantic Scholar API key) are stored in browser `localStorage` rather than a `config.properties` file.

## Privacy

PDFs are not processed (they aren't accepted as input). The reference text the user pastes is sent directly from their browser to Crossref, OpenAlex, Zenodo, and Semantic Scholar. Nothing is sent to this site's host; it's a static page. Reference titles will appear in those four APIs' server logs.

## Running locally

It's a static site. Open `index.html` directly, or serve the folder with anything (`python -m http.server`, `npx serve`, etc.).

## Deploying

Any static host works. Currently deployed to an Azure Blob Storage `$web` container with static website hosting enabled.

## License

[AGPL-3.0](LICENSE), inherited from the upstream project. Because the AGPL §13 network-use clause applies, any hosted instance of this code must make the corresponding source available to its users — that's what this repository is for.

### Third-party components

This distribution bundles AnyStyle-JS and its CRF model + dictionary data, which are BSD-2-Clause licensed. See [NOTICE](NOTICE) for the full attribution list and `anystyle/ANYSTYLE_LICENSE` / `anystyle/ANYSTYLE_DATA_LICENSE` for the verbatim BSD texts.
