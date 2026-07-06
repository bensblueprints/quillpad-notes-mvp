# Launch Strategy — Quillpad

## Positioning
"Plain files, no lock-in, no subscription." Quillpad competes on *ownership*: Notion/Evernote own your data and charge monthly; Obsidian gets the files right but monetizes Sync/Publish subscriptions. Quillpad = the connected-notes experience, one flat $29, data always just markdown in a folder.

## Target communities (rules-aware angles)

| Community | Angle | Rules note |
|---|---|---|
| r/PKMS | "What I learned building a plain-files PKM after leaving Notion" — discussion-first, link in comments | Self-promo tolerated if you engage; lead with substance |
| r/ObsidianMD | Position as *complement*, not attack: "for the friend who won't set up Obsidian" — honest comparison post | Community is loyal; never trash Obsidian, credit it openly |
| r/selfhosted | "Notes that need zero hosting — the folder IS the backend" | Loves local-first + MIT source; mention the repo first |
| r/DataHoarder | Longevity angle: ".md files will outlive every notes startup" | Focus on format durability, not the app |
| r/software / r/windowsapps | Straight "I made this" with screenshots + free source link | Check weekly self-promo thread rules |
| Hacker News | Show HN (below) | Source-first, no marketing tone |
| lobste.rs / tildes | Local-first software design write-up linking the indexer module | Write-up must stand alone technically |

## Show HN draft

**Title:** Show HN: Quillpad – markdown notes where the vault is just a folder of .md files

**Post:**
I got tired of paying $12–15/mo to rent access to my own notes, so I built Quillpad: an Electron notes app where the entire "database" is a folder of plain markdown files.

Point it at any folder. It gives you wikilinks with fuzzy autocomplete (auto-creates missing notes on follow), a backlinks panel with context lines, #tag filtering, full-text search, daily notes, a Ctrl+P switcher, and a global Ctrl+Shift+N quick-capture popup that appends to inbox.md. fs.watch keeps it in sync if you edit files in another editor.

Technical bits: the link/tag indexer is a pure Node module (parses aliases, unicode names, skips code blocks; rename-aware backlink maps) with a real-filesystem test suite. Editor is CodeMirror 6 with syntax-driven live styling. No network calls at all — grep the source.

MIT on GitHub. I sell a $29 one-click installer for people who don't want to npm install, which is the whole business model: pay once, own it forever.

Happy to answer anything about local-first design or why I didn't just use Obsidian.

## SEO keywords (10)
1. markdown notes app windows
2. notion alternative one time purchase
3. local first notes app
4. obsidian alternative no subscription
5. notes app plain text files
6. evernote alternative pay once
7. wikilinks markdown editor
8. second brain app offline
9. note taking app no account
10. zettelkasten app windows

## AppSumo / PitchGround pitch

Quillpad is the anti-subscription notes app: a polished, local-first markdown editor where the user's entire knowledge base lives as plain .md files in a folder they own — wikilinks with autocomplete, backlinks, tags, daily notes, global quick capture, and instant full-text search, with zero cloud, zero account, and zero telemetry. The PKM market has trained users to pay $144–180/year forever (Notion, Evernote) while quietly holding their data hostage in proprietary formats; Quillpad flips that into a lifetime deal that's genuinely credible because there's no server cost behind it — perfect for the Sumo-ling who already owns 40 LTDs and trusts files more than startups. MIT source on GitHub builds trust; the paid product is the convenience installer + updates.

## Pricing math

**$29 one-time.**
- vs Notion Plus ($12/mo): pays for itself in **2.4 months**
- vs Evernote Personal ($14.99/mo): pays for itself in **2 months**
- vs Obsidian Sync ($4/mo standard): pays for itself in **7.3 months**
- 3-year cost of ownership: Quillpad $29 vs Notion $432 vs Evernote $540

Anchor line: "One month of Evernote costs half of Quillpad. Quillpad is forever."
