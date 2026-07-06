'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quill', {
  vaultInfo: () => ipcRenderer.invoke('vault:info'),
  chooseVault: () => ipcRenderer.invoke('vault:choose'),
  openInExplorer: () => ipcRenderer.invoke('vault:openInExplorer'),

  listTree: () => ipcRenderer.invoke('tree:list'),
  readNote: (rel) => ipcRenderer.invoke('note:read', rel),
  writeNote: (rel, content) => ipcRenderer.invoke('note:write', rel, content),
  createNote: (rel, content) => ipcRenderer.invoke('note:create', rel, content),
  renameNote: (oldRel, newRel) => ipcRenderer.invoke('note:rename', oldRel, newRel),
  moveNote: (rel, destFolder) => ipcRenderer.invoke('note:move', rel, destFolder),
  deleteNote: (rel) => ipcRenderer.invoke('note:delete', rel),
  createFolder: (rel) => ipcRenderer.invoke('folder:create', rel),

  noteNames: () => ipcRenderer.invoke('index:names'),
  backlinks: (rel) => ipcRenderer.invoke('index:backlinks', rel),
  tags: () => ipcRenderer.invoke('index:tags'),
  resolveLink: (target) => ipcRenderer.invoke('index:resolve', target),

  search: (q) => ipcRenderer.invoke('search:query', q),
  openDaily: () => ipcRenderer.invoke('daily:open'),

  captureAppend: (text) => ipcRenderer.invoke('capture:append', text),
  captureClose: () => ipcRenderer.invoke('capture:close'),

  onVaultChanged: (cb) => {
    ipcRenderer.on('vault-changed', () => cb());
  },
});
