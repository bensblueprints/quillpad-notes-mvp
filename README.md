# 🪶 Quillpad

**Local-first markdown notes. Your notes are plain `.md` files you own.**

[![License: MIT](https://img.shields.io/badge/License-MIT-8b7cf6.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-262a35)
![Pricing](https://img.shields.io/badge/price-%2429%20once-2ea44f)

Quillpad is a fast, beautiful desktop notes app in the spirit of Notion and Obsidian — except there is no account, no cloud, no database, and no subscription. You point it at a folder. Every note is a real markdown file. Folders are folders. Quit the app, and your entire "knowledge base" is still sitting there in Explorer as portable plain text that will outlive every notes startup.

**Pay once. Own it forever. No subscription.**

![Quillpad screenshot](docs/screenshot.png)

## Features

- 📁 **Your vault is just a folder** — pick any folder (or use the default under Documents). Notes are real `.md` files, folders are folders. Edit them in any other app; Quillpad watches the disk and refreshes live.
- ✍️ **Live-styled markdown editor** — CodeMirror 6 with inline preview styling: sized headings, rendered bold/italic, highlighted code. Toggle a full rendered preview with `Ctrl+E`.
- 🔗 **`[[Wikilinks]]`** — type `[[` for a fuzzy autocomplete over every note name. Aliases (`[[note|label]]`) supported. Click a link to follow it — if the note doesn't exist yet, Quillpad creates it.
- 🔙 **Backlinks panel** — every note shows who links to it, with the context line, one click away.
- #️⃣ **Tags** — `#hashtags` anywhere in a note appear in the tag sidebar; click to filter notes by tag.
- 🔎 **Full-text search** — instant search across every file in the vault with highlighted matches.
- 📅 **Daily notes** — `Ctrl+D` opens (or creates) today's `daily/YYYY-MM-DD.md`.
- ⚡ **Quick capture** — `Ctrl+Shift+N` from *anywhere in Windows* pops a tiny capture window; hit Enter and it's appended to `inbox.md`.
- 🚀 **Quick switcher** — `Ctrl+P` jumps to any note, recent files first.
- 🖱 **Full file management** — create, rename, delete, and drag-and-drop notes and folders in the sidebar tree.
- 🔒 **100% local** — no telemetry, no network calls, ever. Your notes never leave your machine.

## Quick start

```bash
npm i
npm start
```

That's it. Quillpad creates a starter vault at `Documents/Quillpad` (change it any time with the vault button).

Build a Windows installer: `npm run dist`. Run the test suite: `npm test`.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+P` | Quick switcher (recent notes first) |
| `Ctrl+D` | Open/create today's daily note |
| `Ctrl+N` | New note |
| `Ctrl+E` | Toggle full preview |
| `Ctrl+Shift+F` | Search all notes |
| `Ctrl+Shift+N` | Quick capture → `inbox.md` (global, works outside the app) |
| `Ctrl+S` | Save now (auto-save is on anyway) |

## Quillpad vs. subscription note apps

| | **Quillpad** | Notion | Evernote | Obsidian Sync |
|---|---|---|---|---|
| Price | **$29 once** | $12/mo per seat | $14.99/mo | $4–8/mo (app free) |
| Your data | Plain `.md` files in your folder | Their cloud, their format | Their cloud, their format | Files local, sync paid |
| Works offline | **Always** | Partially | Partially | Yes |
| Account required | **No** | Yes | Yes | Yes (for sync) |
| Telemetry | **None** | Yes | Yes | Optional |
| Export needed to leave | **Never — it's already files** | Yes | Yes | No |
| Cost after 3 years | **$29** | $432 | $540 | $144–288 |

## ☕ Skip the setup — get the 1-click installer

The source is free (MIT) and always will be. If you'd rather skip Node/npm and get a signed one-click Windows installer with auto-updates:

**→ [Get Quillpad on Whop — $29, yours forever](https://whop.com/benjisaiempire/quillpad)**

## Tech stack

- **Electron** — main + preload + renderer, context-isolated
- **CodeMirror 6** — markdown editing with live syntax-driven styling
- **marked** — full preview rendering
- **Plain HTML/CSS/JS renderer** bundled with esbuild — no framework, boots instantly
- **Pure-Node core** — `src/indexer.js` (wikilink/tag/backlink index) and `src/vault.js` (fs layer) have zero Electron dependencies and are covered by `test/smoke.js` (28 checks against a real temp-dir vault)

## Architecture notes

- `src/indexer.js` — pure module. Parses `[[wikilinks]]` (aliases, headings, unicode) and `#tags`, ignores anything inside fenced/inline code, and maintains forward-link/backlink/tag maps with rename-aware, plain-file-semantics resolution.
- `src/vault.js` — the fs layer. All note I/O goes through here; it's what the tests exercise against a real filesystem.
- `src/main.js` — Electron main: vault lifecycle, `fs.watch` (with self-write suppression), IPC, global quick-capture shortcut.
- `src/renderer/` — the UI; `app.js` is bundled to `dist/bundle.js` by esbuild on `npm start`.

## License

[MIT](LICENSE) © 2026 Ben (bensblueprints)

## macOS build

See [MAC-BUILD.md](MAC-BUILD.md). Quickest path: GitHub **Actions** tab -> run the **Mac Build** (`mac-build.yml`) workflow to get a downloadable `.dmg` (unsigned - right-click -> Open on first launch).
