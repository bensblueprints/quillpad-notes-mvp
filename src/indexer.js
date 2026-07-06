'use strict';

/**
 * Quillpad indexer — pure module, no fs / no Electron.
 *
 * Parses [[wikilinks]] and #tags out of markdown text and maintains
 * forward-link / backlink / tag maps for a whole vault.
 *
 * Paths are vault-relative, forward-slash separated (e.g. "projects/Foo.md").
 * Link targets resolve by note name (basename without .md), case-insensitive,
 * which matches how people actually write [[wikilinks]].
 */

/**
 * Compute the character ranges of code regions (fenced blocks and inline
 * code spans) so links/tags inside them can be ignored.
 * Returns an array of [start, end) ranges, sorted.
 */
function codeRanges(text) {
  const ranges = [];
  const lines = text.split('\n');
  let offset = 0;
  let fenceOpen = null; // { char, len, start }
  const inlineLines = []; // lines to scan for inline code (offset, text)

  for (const line of lines) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceOpen) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fenceOpen.char &&
        fenceMatch[1].length >= fenceOpen.len
      ) {
        ranges.push([fenceOpen.start, offset + line.length]);
        fenceOpen = null;
      }
    } else if (fenceMatch) {
      fenceOpen = { char: fenceMatch[1][0], len: fenceMatch[1].length, start: offset };
    } else {
      inlineLines.push([offset, line]);
    }
    offset += line.length + 1;
  }
  if (fenceOpen) ranges.push([fenceOpen.start, text.length]); // unclosed fence runs to EOF

  // Inline code spans on non-fenced lines: `...` (backtick runs must match).
  for (const [lineOffset, line] of inlineLines) {
    const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      ranges.push([lineOffset + m.index, lineOffset + m.index + m[0].length]);
    }
  }

  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

function inRanges(pos, ranges) {
  for (const [s, e] of ranges) {
    if (pos >= s && pos < e) return true;
    if (s > pos) break;
  }
  return false;
}

function lineAt(text, pos) {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  let end = text.indexOf('\n', pos);
  if (end === -1) end = text.length;
  return text.slice(start, end).trim();
}

/**
 * Parse a note body. Returns:
 *   {
 *     links: [{ target, alias, heading, raw, offset, context }],
 *     tags:  [lowercase strings, deduped]
 *   }
 * - target: note name, alias split on `|`, heading split on `#` inside the link
 * - links/tags inside fenced code blocks or inline code spans are ignored
 * - unicode note names and tags are supported
 */
function parseNote(text) {
  if (typeof text !== 'string') text = '';
  const ranges = codeRanges(text);
  const links = [];
  const tags = [];
  const seenTags = new Set();

  // Wikilinks: [[target]], [[target|alias]], [[target#heading]], not [[]].
  const linkRe = /\[\[([^\[\]]+?)\]\]/g;
  let m;
  while ((m = linkRe.exec(text)) !== null) {
    if (inRanges(m.index, ranges)) continue;
    // Embeds (![[...]]) still count as links for backlink purposes.
    const inner = m[1];
    const pipe = inner.indexOf('|');
    let targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
    const alias = pipe === -1 ? null : inner.slice(pipe + 1).trim();
    const hash = targetPart.indexOf('#');
    const heading = hash === -1 ? null : targetPart.slice(hash + 1).trim();
    if (hash !== -1) targetPart = targetPart.slice(0, hash);
    const target = targetPart.trim();
    if (!target) continue; // [[#heading]] self-link or empty — skip
    links.push({
      target,
      alias,
      heading,
      raw: m[0],
      offset: m.index,
      context: lineAt(text, m.index),
    });
  }

  // Tags: #tag — starts at line start or after whitespace/punctuation-ish,
  // must contain at least one non-digit char (so "#123" or "# heading" don't match).
  const tagRe = /(^|[\s(\[{>,;])#([\p{L}\p{N}_/-]+)/gmu;
  while ((m = tagRe.exec(text)) !== null) {
    const hashPos = m.index + m[1].length;
    if (inRanges(hashPos, ranges)) continue;
    const name = m[2];
    if (/^\d+$/.test(name)) continue;
    const tag = name.toLowerCase();
    if (!seenTags.has(tag)) {
      seenTags.add(tag);
      tags.push(tag);
    }
  }

  return { links, tags };
}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.?\//, '');
}

function noteNameOf(relPath) {
  const norm = normalizePath(relPath);
  const base = norm.split('/').pop();
  return base.replace(/\.md$/i, '');
}

class Indexer {
  constructor() {
    /** @type {Map<string, {links: any[], tags: string[]}>} path -> parsed */
    this.files = new Map();
  }

  setFile(relPath, content) {
    this.files.set(normalizePath(relPath), parseNote(content));
  }

  removeFile(relPath) {
    this.files.delete(normalizePath(relPath));
  }

  /** Move/rename a file. Its outgoing links move with it; other files'
   *  links keep pointing at whatever name they name (renames change what
   *  resolves, exactly like plain files on disk). */
  renameFile(oldPath, newPath) {
    const oldKey = normalizePath(oldPath);
    const parsed = this.files.get(oldKey);
    if (parsed === undefined) return false;
    this.files.delete(oldKey);
    this.files.set(normalizePath(newPath), parsed);
    return true;
  }

  paths() {
    return [...this.files.keys()];
  }

  /** Resolve a wikilink target to a vault path (case-insensitive by note
   *  name; a target containing '/' matches the end of the path). */
  resolve(target) {
    const t = String(target).trim().toLowerCase().replace(/\.md$/i, '');
    if (!t) return null;
    if (t.includes('/')) {
      for (const p of this.files.keys()) {
        if (p.toLowerCase().replace(/\.md$/i, '').endsWith(t)) return p;
      }
      return null;
    }
    for (const p of this.files.keys()) {
      if (noteNameOf(p).toLowerCase() === t) return p;
    }
    return null;
  }

  /** Outgoing links of a file. */
  linksFrom(relPath) {
    const parsed = this.files.get(normalizePath(relPath));
    return parsed ? parsed.links.slice() : [];
  }

  /** Backlinks: every link in the vault whose target resolves to relPath.
   *  Returns [{ source, target, alias, context }]. */
  backlinksTo(relPath) {
    const key = normalizePath(relPath);
    const name = noteNameOf(key).toLowerCase();
    const pathNoExt = key.toLowerCase().replace(/\.md$/i, '');
    const out = [];
    for (const [source, parsed] of this.files) {
      if (source === key) continue;
      for (const link of parsed.links) {
        const t = link.target.toLowerCase().replace(/\.md$/i, '');
        const hit = t.includes('/') ? pathNoExt.endsWith(t) : t === name;
        if (hit) out.push({ source, target: link.target, alias: link.alias, context: link.context });
      }
    }
    return out;
  }

  /** Map of tag -> sorted [paths]. */
  tagMap() {
    const map = new Map();
    for (const [path, parsed] of this.files) {
      for (const tag of parsed.tags) {
        if (!map.has(tag)) map.set(tag, []);
        map.get(tag).push(path);
      }
    }
    for (const list of map.values()) list.sort();
    return map;
  }

  tagsOf(relPath) {
    const parsed = this.files.get(normalizePath(relPath));
    return parsed ? parsed.tags.slice() : [];
  }

  /** Link targets that don't resolve to any file (for auto-create UX). */
  unresolvedLinks() {
    const out = new Set();
    for (const parsed of this.files.values()) {
      for (const link of parsed.links) {
        if (!this.resolve(link.target)) out.add(link.target);
      }
    }
    return [...out];
  }
}

module.exports = { parseNote, codeRanges, normalizePath, noteNameOf, Indexer };
