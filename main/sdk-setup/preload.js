// Preload of the "Getting Helm ready" window (main/sdk-setup.js): state in, three actions out. Owner: lane installer.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helmSetup', {
  onState: (fn) => { ipcRenderer.on('sdk-setup:state', (_e, s) => fn(s)); ipcRenderer.send('sdk-setup:action', 'hello'); },
  retry: () => ipcRenderer.send('sdk-setup:action', 'retry'),
  quit: () => ipcRenderer.send('sdk-setup:action', 'quit'),
});
