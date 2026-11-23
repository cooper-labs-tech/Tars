# The app's fonts, committed

The three families the window uses, as `next/font/google` downloaded them for the builds the surfaces references were
recorded with: QA's set `050d7d6d6b` (the sha1 of the sorted sha1s of the 17 files). They are committed so no build
depends on what Google serves that day: on 22/11 one build received six different files of the same fonts, and 27 of 45
surfaces screenshots failed on the edges of their glyphs. `src/app/fonts.css` declares them with the same rules
`next/font/google` generated: the same families, weights, styles, unicode ranges, `font-display: swap`, fallback faces
and CSS variables.

Change a file only on purpose, and re-record the surfaces references with it.

| Family | Version | Copyright | Licence |
|---|---|---|---|
| Roboto Condensed | 3.008 | Copyright 2011 Google Inc. All Rights Reserved. | Apache License 2.0, as its files declare: `LICENSE-roboto-condensed-apache-2.0.txt` |
| Roboto Mono | 3.001 | Copyright 2015 The Roboto Mono Project Authors (https://github.com/googlefonts/robotomono) | SIL Open Font License 1.1: `OFL-roboto-mono.txt` |
| Instrument Serif | 1.000 | Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif) | SIL Open Font License 1.1: `OFL-instrument-serif.txt` |

Each family is a variable font split by Google into one file per Unicode subset, and the browser loads a subset only
when the page uses one of its characters.

| File | sha1 |
|---|---|
| `roboto-condensed-cyrillic-ext.woff2` | `a7bc1d767b2f142d5a4bcdd474018c6b01b436b8` |
| `roboto-condensed-cyrillic.woff2` | `36170013a9016b1f4e6a08210de48ec04cf474ed` |
| `roboto-condensed-greek-ext.woff2` | `88572b3531d467bf4b65bed66ae45fc02fdb08c4` |
| `roboto-condensed-greek.woff2` | `f6cc42231ff69636039dc3d6cd4af5233fa6e00e` |
| `roboto-condensed-vietnamese.woff2` | `0571f2df56a4a6b431e9e371154e878bc48615b8` |
| `roboto-condensed-latin-ext.woff2` | `f7457384d18beec4486a6ff3ef53abf234fadab7` |
| `roboto-condensed-latin.woff2` | `488932cae95687941ab44f6f62fc6dc5365acb49` |
| `roboto-mono-cyrillic-ext.woff2` | `b1705201571e54f8609b2cb24d24d3766d35f972` |
| `roboto-mono-cyrillic.woff2` | `a381a6d3ccdb24356cd51f28f86c99140f4f1f11` |
| `roboto-mono-greek.woff2` | `81d1ef341660fde313b700b34ab6fc88e72ed1e3` |
| `roboto-mono-vietnamese.woff2` | `6457dfad7f61a6ecf4e40a23943fe47e611c2809` |
| `roboto-mono-latin-ext.woff2` | `7a7a2d4d66a3e88c78d8cffce4921b3e60268da1` |
| `roboto-mono-latin.woff2` | `28a18dc25313955da6fde06ffafb48f0f5088c15` |
| `instrument-serif-italic-latin-ext.woff2` | `d30d32243e6f1f7dfd3b99e9a6abb99718a4c74a` |
| `instrument-serif-italic-latin.woff2` | `bd51d639d9f210bed8da3fdc5136c3ebe531b22d` |
| `instrument-serif-normal-latin-ext.woff2` | `a0ca5e485ac9f3e403eadf8d0cc650ee617676f1` |
| `instrument-serif-normal-latin.woff2` | `6c8e8a291bdd46678c3dc97ecb41ae3e2177215a` |
