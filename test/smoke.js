'use strict';

/**
 * Quillpad smoke test — runs with `npm test`. No Electron needed.
 *  Part 1: indexer unit tests (link/tag parsing edge cases, backlinks, rename)
 *  Part 2: real-filesystem vault round trip in a temp dir
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseNote, Indexer, noteNameOf } = require('../src/indexer');
const { Vault } = require('../src/vault');

let count = 0;
function check(name, fn) {
  fn();
  count += 1;
  console.log(`  ok ${String(count).padStart(2)} — ${name}`);
}

// ---------------------------------------------------------------- indexer
console.log('\nindexer.js');

check('basic wikilink parsed', () => {
  const { links } = parseNote('See [[Project Plan]] for details.');
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].target, 'Project Plan');
  assert.strictEqual(links[0].alias, null);
});

check('aliased link [[note|label]] splits target and alias', () => {
  const { links } = parseNote('Read [[Project Plan|the plan]] first.');
  assert.strictEqual(links[0].target, 'Project Plan');
  assert.strictEqual(links[0].alias, 'the plan');
});

check('heading link [[note#section]] keeps heading separate', () => {
  const { links } = parseNote('Jump to [[Guide#Setup|setup docs]].');
  assert.strictEqual(links[0].target, 'Guide');
  assert.strictEqual(links[0].heading, 'Setup');
  assert.strictEqual(links[0].alias, 'setup docs');
});

check('links inside fenced code blocks are ignored', () => {
  const md = 'Before [[Real]]\n```\n[[NotALink]]\n```\nAfter [[AlsoReal]]';
  const { links } = parseNote(md);
  assert.deepStrictEqual(links.map((l) => l.target), ['Real', 'AlsoReal']);
});

check('links inside inline code spans are ignored', () => {
  const { links } = parseNote('Use `[[template]]` syntax to link [[Manual]].');
  assert.deepStrictEqual(links.map((l) => l.target), ['Manual']);
});

check('unclosed fence swallows the rest of the file', () => {
  const { links } = parseNote('[[Yes]]\n```js\n[[no]]\n[[still no]]');
  assert.deepStrictEqual(links.map((l) => l.target), ['Yes']);
});

check('unicode note names parse (CJK, accents, emoji)', () => {
  const { links } = parseNote('日記: [[毎日のメモ]] and [[Café Überplan]] and [[🚀 Launch]]');
  assert.deepStrictEqual(
    links.map((l) => l.target),
    ['毎日のメモ', 'Café Überplan', '🚀 Launch']
  );
});

check('empty and malformed links are skipped', () => {
  const { links } = parseNote('Bad: [[]] and [[#heading-only]] and [[  ]] ok: [[Fine]]');
  assert.deepStrictEqual(links.map((l) => l.target), ['Fine']);
});

check('link context is its trimmed line', () => {
  const { links } = parseNote('line one\n  - a bullet with [[Target]] inside  \nline three');
  assert.strictEqual(links[0].context, '- a bullet with [[Target]] inside');
});

check('tags parsed, lowercased, deduped; headings and numbers excluded', () => {
  const { tags } = parseNote('# Heading\n#Alpha stuff #alpha #beta-2 #123 x#notatag #日本語');
  assert.deepStrictEqual(tags, ['alpha', 'beta-2', '日本語']);
});

check('tags inside code are ignored', () => {
  const { tags } = parseNote('`#nope` and\n```\n#alsonope\n```\n#yes');
  assert.deepStrictEqual(tags, ['yes']);
});

check('backlink map: multiple sources, alias links counted', () => {
  const idx = new Indexer();
  idx.setFile('a.md', 'Link to [[c]]');
  idx.setFile('b.md', 'Alias link to [[C|see c]]');
  idx.setFile('c.md', 'I link to [[a]]');
  const bl = idx.backlinksTo('c.md');
  assert.deepStrictEqual(bl.map((b) => b.source).sort(), ['a.md', 'b.md']);
  assert.strictEqual(idx.backlinksTo('a.md').length, 1);
  assert.strictEqual(idx.backlinksTo('b.md').length, 0);
});

check('resolution is case-insensitive and folder-agnostic', () => {
  const idx = new Indexer();
  idx.setFile('projects/Deep Note.md', 'x');
  assert.strictEqual(idx.resolve('deep note'), 'projects/Deep Note.md');
  assert.strictEqual(idx.resolve('projects/Deep Note'), 'projects/Deep Note.md');
  assert.strictEqual(idx.resolve('missing'), null);
});

check('backlink map correct after a file rename', () => {
  const idx = new Indexer();
  idx.setFile('notes/old.md', 'outgoing [[hub]]');
  idx.setFile('hub.md', 'links back to [[old]]');
  assert.strictEqual(idx.backlinksTo('notes/old.md').length, 1);

  idx.renameFile('notes/old.md', 'notes/new.md');
  // outgoing links moved with the file
  assert.deepStrictEqual(idx.linksFrom('notes/new.md').map((l) => l.target), ['hub']);
  assert.strictEqual(idx.linksFrom('notes/old.md').length, 0);
  // hub's [[old]] no longer resolves to the renamed file (plain-file semantics)
  assert.strictEqual(idx.backlinksTo('notes/new.md').length, 0);
  assert.strictEqual(idx.resolve('old'), null);
  // hub still receives the backlink from the moved file
  assert.deepStrictEqual(idx.backlinksTo('hub.md').map((b) => b.source), ['notes/new.md']);
  // and [[old]] shows up as unresolved (auto-create candidate)
  assert.ok(idx.unresolvedLinks().includes('old'));
});

check('tag map aggregates across files', () => {
  const idx = new Indexer();
  idx.setFile('one.md', '#shared #solo');
  idx.setFile('two.md', 'text #Shared');
  const map = idx.tagMap();
  assert.deepStrictEqual(map.get('shared'), ['one.md', 'two.md']);
  assert.deepStrictEqual(map.get('solo'), ['one.md']);
});

check('noteNameOf handles windows separators and extension', () => {
  assert.strictEqual(noteNameOf('a\\b\\My Note.md'), 'My Note');
  assert.strictEqual(noteNameOf('plain.md'), 'plain');
});

// ---------------------------------------------------------------- vault (real FS)
console.log('\nvault.js — real filesystem round trip');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quillpad-test-'));

try {
  const vault = new Vault(tmp);
  const idx = new Indexer();
  const reindex = () => {
    idx.files.clear();
    for (const { path: p, content } of vault.readAll()) idx.setFile(p, content);
  };

  check('create writes a real .md file on disk', () => {
    const rel = vault.create('Ideas.md', '# Ideas\n\nLink to [[Journal]] #brainstorm\n');
    assert.strictEqual(rel, 'Ideas.md');
    assert.ok(fs.existsSync(path.join(tmp, 'Ideas.md')));
  });

  check('create dedupes name collisions', () => {
    const rel = vault.create('Ideas.md', 'second');
    assert.strictEqual(rel, 'Ideas 2.md');
    vault.remove(rel);
  });

  check('folders are real folders; nested create works', () => {
    vault.mkdir('projects');
    const rel = vault.create('projects/Journal.md', '# Journal\n\nBack to [[Ideas]]\n');
    assert.strictEqual(rel, 'projects/Journal.md');
    assert.ok(fs.statSync(path.join(tmp, 'projects')).isDirectory());
  });

  check('index built from disk finds backlinks both ways', () => {
    reindex();
    assert.deepStrictEqual(idx.backlinksTo('projects/Journal.md').map((b) => b.source), ['Ideas.md']);
    assert.deepStrictEqual(idx.backlinksTo('Ideas.md').map((b) => b.source), ['projects/Journal.md']);
    assert.deepStrictEqual(idx.tagsOf('Ideas.md'), ['brainstorm']);
  });

  check('rename through fs layer + index update stays consistent', () => {
    const actual = vault.rename('projects/Journal.md', 'projects/Log.md');
    assert.strictEqual(actual, 'projects/Log.md');
    assert.ok(!fs.existsSync(path.join(tmp, 'projects', 'Journal.md')));
    idx.renameFile('projects/Journal.md', actual);
    assert.deepStrictEqual(idx.backlinksTo('Ideas.md').map((b) => b.source), ['projects/Log.md']);
    assert.strictEqual(idx.resolve('Journal'), null); // old name gone
  });

  check('move through fs layer relocates the file', () => {
    const moved = vault.move('projects/Log.md', '');
    assert.strictEqual(moved, 'Log.md');
    assert.ok(fs.existsSync(path.join(tmp, 'Log.md')));
    idx.renameFile('projects/Log.md', moved);
    assert.deepStrictEqual(idx.backlinksTo('Ideas.md').map((b) => b.source), ['Log.md']);
  });

  check('full-text search finds content with line + offsets', () => {
    vault.write('search-me.md', 'first line\nthe NEEDLE is here\nlast line\n');
    const results = vault.search('needle');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].path, 'search-me.md');
    const m = results[0].matches[0];
    assert.strictEqual(m.lineNo, 2);
    assert.strictEqual(results[0].matches[0].line.slice(m.start, m.end), 'NEEDLE');
  });

  check('search misses return empty', () => {
    assert.deepStrictEqual(vault.search('zzz-not-here-zzz'), []);
  });

  check('daily note path logic (zero-padded, /daily)', () => {
    assert.strictEqual(Vault.dailyPath(new Date(2026, 0, 5)), 'daily/2026-01-05.md');
    assert.strictEqual(Vault.dailyPath(new Date(2026, 11, 31)), 'daily/2026-12-31.md');
  });

  check('openDaily creates the file once and is idempotent', () => {
    const rel = vault.openDaily(new Date(2026, 6, 6));
    assert.strictEqual(rel, 'daily/2026-07-06.md');
    assert.ok(fs.existsSync(path.join(tmp, 'daily', '2026-07-06.md')));
    vault.write(rel, '# 2026-07-06\n\nedited\n');
    vault.openDaily(new Date(2026, 6, 6)); // must not overwrite
    assert.ok(vault.read(rel).includes('edited'));
  });

  check('appendInbox appends, never clobbers', () => {
    vault.appendInbox('first thought');
    vault.appendInbox('second thought');
    const inbox = vault.read('inbox.md');
    assert.ok(inbox.includes('first thought'));
    assert.ok(inbox.includes('second thought'));
    assert.ok(inbox.indexOf('first thought') < inbox.indexOf('second thought'));
  });

  check('tree lists folders before notes, ignores dot-dirs', () => {
    fs.mkdirSync(path.join(tmp, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.hidden', 'x.md'), 'nope');
    const tree = vault.tree();
    const names = tree.map((n) => n.name);
    assert.ok(!names.includes('.hidden'));
    const types = tree.map((n) => n.type);
    assert.deepStrictEqual([...types].sort(), types.slice().sort()); // folder..note order is stable
    assert.strictEqual(types[0], 'folder');
  });

  check('path escape is rejected', () => {
    assert.throws(() => vault.read('../outside.md'), /escapes vault/);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nAll ${count} smoke checks passed.\n`);
