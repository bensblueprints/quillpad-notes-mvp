'use strict';

import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  placeholder,
  Decoration,
  ViewPlugin,
  MatchDecorator,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { marked } from 'marked';

const api = window.quill;
const $ = (id) => document.getElementById(id);

// ---------------- state ----------------
let currentPath = null;
let saveTimer = null;
let editor = null;
let previewOn = false;
let noteNamesCache = []; // [{path, name}]
let recent = JSON.parse(localStorage.getItem('quill.recent') || '[]');
let activeTag = null;
let suppressNextWatch = false;

function rememberRecent(path) {
  recent = [path, ...recent.filter((p) => p !== path)].slice(0, 30);
  localStorage.setItem('quill.recent', JSON.stringify(recent));
}

// ---------------- fuzzy ----------------
function fuzzyScore(query, target) {
  const q = query.toLowerCase();
  const s = target.toLowerCase();
  if (!q) return 1;
  if (s === q) return 1000;
  if (s.startsWith(q)) return 500 - s.length;
  if (s.includes(q)) return 250 - s.indexOf(q) - s.length * 0.1;
  // subsequence
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      qi += 1;
      streak += 1;
      score += streak * 3;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score - s.length * 0.1 : -1;
}

function fuzzyFilter(query, items, key) {
  return items
    .map((it) => ({ it, score: fuzzyScore(query, key(it)) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.it);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------- CodeMirror setup ----------------
const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.7em', fontWeight: '700', color: '#eceef4' },
  { tag: t.heading2, fontSize: '1.4em', fontWeight: '700', color: '#eceef4' },
  { tag: t.heading3, fontSize: '1.2em', fontWeight: '600', color: '#eceef4' },
  { tag: t.heading4, fontSize: '1.08em', fontWeight: '600', color: '#eceef4' },
  { tag: t.strong, fontWeight: '700', color: '#eceef4' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: '#8b90a0' },
  { tag: t.monospace, fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: '0.9em', color: '#a5d6a7', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '3px' },
  { tag: t.link, color: '#8b7cf6' },
  { tag: t.url, color: '#6d64b8' },
  { tag: t.quote, color: '#9aa0b4', fontStyle: 'italic' },
  { tag: t.list, color: '#8b7cf6' },
  { tag: t.meta, color: '#5c6272' },
  { tag: t.processingInstruction, color: '#5c6272' },
  { tag: t.contentSeparator, color: '#5c6272' },
]);

const wlMatcher = new MatchDecorator({
  regexp: /\[\[[^\[\]]+\]\]/g,
  decoration: Decoration.mark({ class: 'cm-wikilink' }),
});
const wikilinkPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.deco = wlMatcher.createDeco(view); }
    update(u) { this.deco = wlMatcher.updateDeco(u, this.deco); }
  },
  { decorations: (v) => v.deco }
);

const tagMatcher = new MatchDecorator({
  regexp: /(^|[\s(\[{>,;])(#[\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*)/gu,
  decorate: (add, from, to, match) => {
    const start = from + match[1].length;
    add(start, to, Decoration.mark({ class: 'cm-hashtag' }));
  },
});
const hashtagPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.deco = tagMatcher.createDeco(view); }
    update(u) { this.deco = tagMatcher.updateDeco(u, this.deco); }
  },
  { decorations: (v) => v.deco }
);

function wikilinkCompletions(context) {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const m = before.match(/\[\[([^\[\]|#]*)$/);
  if (!m) return null;
  const from = context.pos - m[1].length;
  const names = fuzzyFilter(m[1], noteNamesCache, (n) => n.name).slice(0, 40);
  return {
    from,
    filter: false,
    options: names.map((n) => ({
      label: n.name,
      detail: n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '',
      apply: (view, completion, f, to) => {
        const after = view.state.sliceDoc(to, to + 2);
        const closing = after === ']]' ? '' : ']]';
        view.dispatch({
          changes: { from: f, to, insert: n.name + closing },
          selection: { anchor: f + n.name.length + 2 },
        });
      },
    })),
  };
}

async function followLink(target) {
  let path = await api.resolveLink(target);
  if (!path) {
    path = await api.createNote(target + '.md', `# ${target}\n\n`);
    await refreshTree();
  }
  await openNote(path);
}

function linkAtPos(view, pos) {
  const line = view.state.doc.lineAt(pos);
  const re = /\[\[([^\[\]]+?)\]\]/g;
  let m;
  while ((m = re.exec(line.text)) !== null) {
    const from = line.from + m.index;
    const to = from + m[0].length;
    if (pos >= from && pos <= to) {
      let target = m[1].split('|')[0].split('#')[0].trim();
      return target || null;
    }
  }
  return null;
}

function makeEditor(content) {
  if (editor) editor.destroy();
  editor = new EditorView({
    parent: $('editor-host'),
    state: EditorState.create({
      doc: content,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        placeholder('Write… ([[ to link, # to tag)'),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(mdHighlight),
        wikilinkPlugin,
        hashtagPlugin,
        autocompletion({ override: [wikilinkCompletions], activateOnTyping: true }),
        keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.domEventHandlers({
          mousedown: (e, view) => {
            const el = e.target.closest && e.target.closest('.cm-wikilink');
            if (!el) return false;
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos == null) return false;
            const target = linkAtPos(view, pos);
            if (!target) return false;
            e.preventDefault();
            followLink(target);
            return true;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) scheduleSave();
        }),
      ],
    }),
  });
}

// ---------------- open / save ----------------
async function openNote(path) {
  await flushSave();
  let content;
  try {
    content = await api.readNote(path);
  } catch {
    return; // deleted externally
  }
  currentPath = path;
  rememberRecent(path);
  $('empty-state').classList.add('hidden');
  $('note-title').textContent = path.replace(/\.md$/i, '');
  makeEditor(content);
  if (previewOn) renderPreview();
  else editor.focus();
  await Promise.all([refreshBacklinks(), refreshTreeSelection()]);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!currentPath || !editor) return;
  await api.writeNote(currentPath, editor.state.doc.toString());
  refreshBacklinks();
  refreshTags();
}

// ---------------- preview ----------------
function mdToHtml(src) {
  // wikilinks -> anchors, tags -> spans (before markdown parse)
  const pre = src
    .replace(/\[\[([^\[\]]+?)\]\]/g, (_, inner) => {
      const [rawTarget, alias] = inner.split('|');
      const target = rawTarget.split('#')[0].trim();
      const label = (alias || rawTarget).trim();
      return `<a class="wl" data-target="${escapeHtml(target)}">${escapeHtml(label)}</a>`;
    })
    .replace(/(^|[\s(\[{>,;])#([\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*)/gmu, (m, lead, tag) => `${lead}<span class="tag">#${escapeHtml(tag)}</span>`);
  return marked.parse(pre, { mangle: false, headerIds: false });
}

function renderPreview() {
  const src = editor ? editor.state.doc.toString() : '';
  $('preview').innerHTML = mdToHtml(src);
}

function setPreview(on) {
  previewOn = on;
  $('preview').classList.toggle('hidden', !on);
  $('editor-host').classList.toggle('hidden', on);
  $('btn-preview').classList.toggle('on', on);
  if (on) renderPreview();
  else if (editor) editor.focus();
}

$('preview').addEventListener('click', (e) => {
  const wl = e.target.closest('.wl');
  if (wl) followLink(wl.dataset.target);
});

// ---------------- file tree ----------------
let treeData = [];
const openFolders = new Set(JSON.parse(localStorage.getItem('quill.openFolders') || '[]'));

function persistFolders() {
  localStorage.setItem('quill.openFolders', JSON.stringify([...openFolders]));
}

function renderTree() {
  const root = $('tree');
  root.innerHTML = '';
  const build = (nodes, container) => {
    for (const node of nodes) {
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.draggable = true;
      item.dataset.path = node.path;
      item.dataset.type = node.type;
      if (node.type === 'folder') {
        const open = openFolders.has(node.path);
        item.innerHTML = `<span class="caret ${open ? 'open' : ''}">▶</span><span class="icon">📁</span><span>${escapeHtml(node.name)}</span>`;
        container.appendChild(item);
        const kids = document.createElement('div');
        kids.className = 'tree-children';
        if (!open) kids.style.display = 'none';
        container.appendChild(kids);
        build(node.children, kids);
        item.addEventListener('click', () => {
          const nowOpen = kids.style.display === 'none';
          kids.style.display = nowOpen ? '' : 'none';
          item.querySelector('.caret').classList.toggle('open', nowOpen);
          if (nowOpen) openFolders.add(node.path);
          else openFolders.delete(node.path);
          persistFolders();
        });
        addDropTarget(item, node.path);
      } else {
        item.innerHTML = `<span class="caret"></span><span class="icon">📄</span><span>${escapeHtml(node.name)}</span>`;
        if (node.path === currentPath) item.classList.add('active');
        item.addEventListener('click', () => openNote(node.path));
        container.appendChild(item);
      }
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/quill-path', node.path);
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, node);
      });
    }
  };
  build(treeData, root);
  addDropTarget(root, ''); // vault root
}

function addDropTarget(el, folderPath) {
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/quill-path')) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drag-over');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drag-over');
    const src = e.dataTransfer.getData('text/quill-path');
    if (!src || src === folderPath || folderPath.startsWith(src + '/')) return;
    try {
      const moved = await api.moveNote(src, folderPath);
      if (currentPath === src) {
        currentPath = moved;
        $('note-title').textContent = moved.replace(/\.md$/i, '');
      }
      await refreshAll();
    } catch (err) {
      console.error(err);
    }
  });
}

async function refreshTree() {
  treeData = await api.listTree();
  noteNamesCache = await api.noteNames();
  renderTree();
}

function refreshTreeSelection() {
  document.querySelectorAll('.tree-item.active').forEach((el) => el.classList.remove('active'));
  const el = document.querySelector(`.tree-item[data-path="${CSS.escape(currentPath || '')}"]`);
  if (el) el.classList.add('active');
}

// ---------------- context menu ----------------
function showContextMenu(x, y, node) {
  const menu = $('ctx-menu');
  const items = [];
  if (node.type === 'folder') {
    items.push({ label: 'New note here', fn: () => newNotePrompt(node.path) });
    items.push({ label: 'New folder here', fn: () => newFolderPrompt(node.path) });
    items.push({ sep: true });
  }
  items.push({ label: 'Rename', fn: () => renamePrompt(node) });
  items.push({ label: 'Delete', danger: true, fn: () => deleteNode(node) });
  menu.innerHTML = '';
  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (it.danger ? ' danger' : '');
    el.textContent = it.label;
    el.addEventListener('click', () => {
      hideContextMenu();
      it.fn();
    });
    menu.appendChild(el);
  }
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}

function hideContextMenu() {
  $('ctx-menu').classList.add('hidden');
}
document.addEventListener('click', hideContextMenu);

// ---------------- prompt modal ----------------
function ask(label, initial = '') {
  return new Promise((resolve) => {
    const modal = $('prompt');
    const input = $('prompt-input');
    $('prompt-label').textContent = label;
    input.value = initial;
    modal.classList.remove('hidden');
    input.focus();
    input.select();
    const done = (val) => {
      modal.classList.add('hidden');
      input.removeEventListener('keydown', onKey);
      $('prompt-ok').onclick = null;
      $('prompt-cancel').onclick = null;
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Enter') done(input.value.trim());
      if (e.key === 'Escape') done(null);
    };
    input.addEventListener('keydown', onKey);
    $('prompt-ok').onclick = () => done(input.value.trim());
    $('prompt-cancel').onclick = () => done(null);
  });
}

async function newNotePrompt(folder = '') {
  const name = await ask('New note name');
  if (!name) return;
  const rel = folder ? `${folder}/${name}` : name;
  const actual = await api.createNote(rel, `# ${name}\n\n`);
  await refreshTree();
  await openNote(actual);
}

async function newFolderPrompt(parent = '') {
  const name = await ask('New folder name');
  if (!name) return;
  await api.createFolder(parent ? `${parent}/${name}` : name);
  await refreshTree();
}

async function renamePrompt(node) {
  const isNote = node.type === 'note';
  const oldName = node.name;
  const name = await ask(`Rename ${node.type}`, oldName);
  if (!name || name === oldName) return;
  const dir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/') + 1) : '';
  const newRel = dir + name + (isNote ? '.md' : '');
  try {
    const actual = await api.renameNote(node.path, newRel);
    if (currentPath === node.path) {
      currentPath = actual;
      $('note-title').textContent = actual.replace(/\.md$/i, '');
    } else if (!isNote && currentPath && currentPath.startsWith(node.path + '/')) {
      currentPath = actual + currentPath.slice(node.path.length);
    }
    await refreshAll();
  } catch (err) {
    console.error(err);
  }
}

async function deleteNode(node) {
  const sure = await ask(`Type DELETE to remove "${node.name}"${node.type === 'folder' ? ' and everything in it' : ''}`);
  if (sure !== 'DELETE') return;
  await api.deleteNote(node.path);
  if (currentPath === node.path || (currentPath && currentPath.startsWith(node.path + '/'))) {
    currentPath = null;
    if (editor) editor.destroy();
    editor = null;
    $('note-title').textContent = 'No note open';
    $('empty-state').classList.remove('hidden');
  }
  await refreshAll();
}

// ---------------- backlinks ----------------
async function refreshBacklinks() {
  const list = $('backlinks-list');
  if (!currentPath) {
    list.innerHTML = '<p class="dim pad">Nothing links here yet.</p>';
    return;
  }
  const links = await api.backlinks(currentPath);
  if (!links.length) {
    list.innerHTML = '<p class="dim pad">Nothing links here yet.</p>';
    return;
  }
  list.innerHTML = '';
  for (const bl of links) {
    const el = document.createElement('div');
    el.className = 'bl-item';
    el.innerHTML = `<div class="bl-source">${escapeHtml(bl.source.replace(/\.md$/i, ''))}</div><div class="bl-context">${escapeHtml(bl.context)}</div>`;
    el.addEventListener('click', () => openNote(bl.source));
    list.appendChild(el);
  }
}

// ---------------- tags ----------------
async function refreshTags() {
  const tags = await api.tags();
  tags.sort((a, b) => b.paths.length - a.paths.length || a.tag.localeCompare(b.tag));
  const list = $('tag-list');
  list.innerHTML = '';
  if (!tags.length) {
    list.innerHTML = '<span class="dim">No #tags yet</span>';
    return;
  }
  for (const { tag, paths } of tags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip' + (activeTag === tag ? ' active' : '');
    chip.innerHTML = `#${escapeHtml(tag)} <span class="count">${paths.length}</span>`;
    chip.addEventListener('click', () => toggleTagFilter(tag, paths));
    list.appendChild(chip);
  }
}

async function toggleTagFilter(tag, paths) {
  if (activeTag === tag) {
    activeTag = null;
    exitSearchMode();
    refreshTags();
    return;
  }
  activeTag = tag;
  const box = $('search-results');
  box.innerHTML = `<div class="sr-empty">Notes tagged <b>#${escapeHtml(tag)}</b> — click tag again to clear.</div>`;
  for (const p of paths) {
    const el = document.createElement('div');
    el.className = 'sr-file';
    el.textContent = p.replace(/\.md$/i, '');
    el.addEventListener('click', () => openNote(p));
    box.appendChild(el);
  }
  box.classList.remove('hidden');
  $('tree-wrap').classList.add('hidden');
  refreshTags();
}

// ---------------- search ----------------
let searchTimer = null;
$('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) {
    exitSearchMode();
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 150);
});
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.target.value = '';
    exitSearchMode();
    if (editor) editor.focus();
  }
});

function exitSearchMode() {
  activeTag = null;
  $('search-results').classList.add('hidden');
  $('tree-wrap').classList.remove('hidden');
}

async function runSearch(q) {
  activeTag = null;
  const results = await api.search(q);
  const box = $('search-results');
  box.innerHTML = '';
  if (!results.length) {
    box.innerHTML = '<div class="sr-empty">No matches.</div>';
  }
  for (const r of results) {
    const file = document.createElement('div');
    file.className = 'sr-file';
    file.textContent = r.path.replace(/\.md$/i, '');
    file.addEventListener('click', () => openNote(r.path));
    box.appendChild(file);
    for (const m of r.matches) {
      const line = document.createElement('div');
      line.className = 'sr-line';
      const before = escapeHtml(m.line.slice(Math.max(0, m.start - 30), m.start));
      const hit = escapeHtml(m.line.slice(m.start, m.end));
      const after = escapeHtml(m.line.slice(m.end, m.end + 60));
      line.innerHTML = `${m.start > 30 ? '…' : ''}${before}<mark>${hit}</mark>${after}`;
      line.title = `line ${m.lineNo}`;
      line.addEventListener('click', () => openNote(r.path));
      box.appendChild(line);
    }
  }
  box.classList.remove('hidden');
  $('tree-wrap').classList.add('hidden');
}

// ---------------- quick switcher ----------------
let swSelected = 0;
let swItems = [];

function openSwitcher() {
  $('switcher').classList.remove('hidden');
  const input = $('switcher-input');
  input.value = '';
  renderSwitcher('');
  input.focus();
}

function closeSwitcher() {
  $('switcher').classList.add('hidden');
  if (editor && !previewOn) editor.focus();
}

function renderSwitcher(q) {
  const recentSet = new Set(recent);
  let items;
  if (!q) {
    const rest = noteNamesCache.filter((n) => !recentSet.has(n.path));
    items = [
      ...recent.map((p) => noteNamesCache.find((n) => n.path === p)).filter(Boolean),
      ...rest,
    ];
  } else {
    items = fuzzyFilter(q, noteNamesCache, (n) => n.name + ' ' + n.path);
  }
  swItems = items.slice(0, 50);
  swSelected = 0;
  const list = $('switcher-list');
  list.innerHTML = '';
  swItems.forEach((n, i) => {
    const el = document.createElement('div');
    el.className = 'sw-item' + (i === 0 ? ' selected' : '');
    const dot = recentSet.has(n.path) && !q ? '<span class="recent-dot">•</span>' : '';
    el.innerHTML = `<span class="sw-name">${dot}${escapeHtml(n.name)}</span><span class="sw-path">${escapeHtml(n.path)}</span>`;
    el.addEventListener('click', () => {
      closeSwitcher();
      openNote(n.path);
    });
    list.appendChild(el);
  });
}

$('switcher-input').addEventListener('input', (e) => renderSwitcher(e.target.value.trim()));
$('switcher-input').addEventListener('keydown', (e) => {
  const list = $('switcher-list');
  if (e.key === 'Escape') closeSwitcher();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    swSelected = Math.max(0, Math.min(swItems.length - 1, swSelected + (e.key === 'ArrowDown' ? 1 : -1)));
    [...list.children].forEach((el, i) => el.classList.toggle('selected', i === swSelected));
    list.children[swSelected] && list.children[swSelected].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    const n = swItems[swSelected];
    if (n) {
      closeSwitcher();
      openNote(n.path);
    }
  }
});
$('switcher').addEventListener('mousedown', (e) => {
  if (e.target === $('switcher')) closeSwitcher();
});

// ---------------- toolbar / shortcuts ----------------
$('btn-new-note').addEventListener('click', () => newNotePrompt(''));
$('btn-new-folder').addEventListener('click', () => newFolderPrompt(''));
$('btn-daily').addEventListener('click', openDaily);
$('btn-preview').addEventListener('click', () => setPreview(!previewOn));
$('btn-backlinks').addEventListener('click', () => $('backlinks-panel').classList.toggle('hidden'));
$('btn-explorer').addEventListener('click', () => api.openInExplorer());
$('btn-vault').addEventListener('click', async () => {
  const res = await api.chooseVault();
  if (res) {
    currentPath = null;
    recent = [];
    localStorage.setItem('quill.recent', '[]');
    if (editor) editor.destroy();
    editor = null;
    $('note-title').textContent = 'No note open';
    $('empty-state').classList.remove('hidden');
    $('vault-path').textContent = res.root;
    $('vault-path').title = res.root;
    await refreshAll();
  }
});

async function openDaily() {
  const rel = await api.openDaily();
  await refreshTree();
  await openNote(rel);
}

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) {
    if (e.key === 'Escape' && !$('switcher').classList.contains('hidden')) closeSwitcher();
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'p') { e.preventDefault(); openSwitcher(); }
  else if (k === 'd') { e.preventDefault(); openDaily(); }
  else if (k === 'e') { e.preventDefault(); setPreview(!previewOn); }
  else if (k === 'n' && !e.shiftKey) { e.preventDefault(); newNotePrompt(''); }
  else if (k === 'f' && e.shiftKey) { e.preventDefault(); $('search-input').focus(); }
  else if (k === 's') { e.preventDefault(); flushSave(); }
});

// ---------------- external changes ----------------
api.onVaultChanged(async () => {
  await refreshAll();
  // reload current note if it changed on disk and we're not mid-edit
  if (currentPath && !saveTimer && editor) {
    try {
      const disk = await api.readNote(currentPath);
      if (disk !== editor.state.doc.toString()) {
        const sel = Math.min(editor.state.selection.main.head, disk.length);
        editor.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: disk },
          selection: { anchor: sel },
        });
        if (previewOn) renderPreview();
      }
    } catch {
      // note was deleted externally
    }
  }
});

async function refreshAll() {
  await Promise.all([refreshTree(), refreshTags(), refreshBacklinks()]);
}

// ---------------- boot ----------------
(async function init() {
  const info = await api.vaultInfo();
  $('vault-path').textContent = info.root;
  $('vault-path').title = info.root;
  await refreshAll();
  const last = recent.find((p) => noteNamesCache.some((n) => n.path === p));
  const first = last || (noteNamesCache[0] && noteNamesCache[0].path);
  if (first) await openNote(first);
})();
