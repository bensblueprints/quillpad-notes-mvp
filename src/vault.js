'use strict';

/**
 * Quillpad vault — the fs layer. Plain Node, no Electron, unit-testable.
 * All note paths are vault-relative with forward slashes ("daily/2026-07-06.md").
 * Notes are REAL .md files; folders are folders. No database, no lock-in.
 */

const fs = require('fs');
const path = require('path');

const IGNORED_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);

function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

class Vault {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  abs(rel) {
    const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = path.resolve(this.root, clean);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error('Path escapes vault: ' + rel);
    }
    return abs;
  }

  exists(rel) {
    return fs.existsSync(this.abs(rel));
  }

  /** Nested tree of the vault: { name, path, type: 'folder'|'note', children? } */
  tree() {
    const walk = (absDir) => {
      const entries = fs.readdirSync(absDir, { withFileTypes: true });
      const nodes = [];
      for (const e of entries) {
        if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
        const absChild = path.join(absDir, e.name);
        if (e.isDirectory()) {
          nodes.push({
            name: e.name,
            path: toRel(this.root, absChild),
            type: 'folder',
            children: walk(absChild),
          });
        } else if (e.isFile() && /\.md$/i.test(e.name)) {
          nodes.push({
            name: e.name.replace(/\.md$/i, ''),
            path: toRel(this.root, absChild),
            type: 'note',
            mtime: fs.statSync(absChild).mtimeMs,
          });
        }
      }
      nodes.sort((a, b) =>
        a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name)
      );
      return nodes;
    };
    return walk(this.root);
  }

  /** Flat list of all .md files (vault-relative paths). */
  listNotes() {
    const out = [];
    const collect = (nodes) => {
      for (const n of nodes) {
        if (n.type === 'note') out.push(n.path);
        else collect(n.children);
      }
    };
    collect(this.tree());
    return out;
  }

  read(rel) {
    return fs.readFileSync(this.abs(rel), 'utf8');
  }

  write(rel, content) {
    const abs = this.abs(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  /** Create a note; returns the rel path actually used (dedupes "Name 2.md"). */
  create(rel, content = '') {
    let abs = this.abs(rel);
    if (!/\.md$/i.test(abs)) abs += '.md';
    const dir = path.dirname(abs);
    const base = path.basename(abs, '.md');
    fs.mkdirSync(dir, { recursive: true });
    let candidate = abs;
    let i = 2;
    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, `${base} ${i}.md`);
      i += 1;
    }
    fs.writeFileSync(candidate, content, 'utf8');
    return toRel(this.root, candidate);
  }

  mkdir(rel) {
    fs.mkdirSync(this.abs(rel), { recursive: true });
    return String(rel).replace(/\\/g, '/');
  }

  /** Rename or move a note/folder. Returns the new rel path. */
  rename(oldRel, newRel) {
    let dest = this.abs(newRel);
    const src = this.abs(oldRel);
    if (fs.statSync(src).isFile() && !/\.md$/i.test(dest)) dest += '.md';
    if (fs.existsSync(dest)) throw new Error('Target already exists: ' + newRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return toRel(this.root, dest);
  }

  /** Move a note/folder into a folder (''=vault root). Returns new rel path. */
  move(rel, destFolderRel) {
    const name = path.basename(this.abs(rel));
    const target = destFolderRel ? `${destFolderRel}/${name}` : name;
    if (this.abs(target) === this.abs(rel)) return String(rel).replace(/\\/g, '/');
    return this.rename(rel, target);
  }

  remove(rel) {
    const abs = this.abs(rel);
    fs.rmSync(abs, { recursive: true, force: true });
  }

  /** Read every note: [{ path, content }]. */
  readAll() {
    return this.listNotes().map((p) => ({ path: p, content: this.read(p) }));
  }

  /**
   * Full-text search. Case-insensitive substring over all notes.
   * Returns [{ path, matches: [{ lineNo, line, start, end }] }] capped per file.
   */
  search(query, { maxPerFile = 5, maxFiles = 100 } = {}) {
    const q = String(query).toLowerCase();
    if (!q) return [];
    const results = [];
    for (const rel of this.listNotes()) {
      let content;
      try {
        content = this.read(rel);
      } catch {
        continue;
      }
      const lower = content.toLowerCase();
      if (!lower.includes(q)) continue;
      const matches = [];
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && matches.length < maxPerFile; i++) {
        const idx = lines[i].toLowerCase().indexOf(q);
        if (idx !== -1) {
          matches.push({ lineNo: i + 1, line: lines[i], start: idx, end: idx + q.length });
        }
      }
      results.push({ path: rel, matches });
      if (results.length >= maxFiles) break;
    }
    return results;
  }

  /** Path of the daily note for a date (local time): daily/YYYY-MM-DD.md */
  static dailyPath(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `daily/${y}-${m}-${d}.md`;
  }

  /** Open-or-create today's daily note; returns its rel path. */
  openDaily(date = new Date()) {
    const rel = Vault.dailyPath(date);
    if (!this.exists(rel)) {
      this.write(rel, `# ${rel.slice(6, -3)}\n\n`);
    }
    return rel;
  }

  /** Append a quick-capture line to inbox.md (creates it if missing). */
  appendInbox(text) {
    const rel = 'inbox.md';
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const line = `- ${stamp} — ${String(text).trim()}\n`;
    const existing = this.exists(rel) ? this.read(rel) : '# Inbox\n\n';
    const sep = existing.endsWith('\n') || existing === '' ? '' : '\n';
    this.write(rel, existing + sep + line);
    return rel;
  }
}

module.exports = { Vault };
