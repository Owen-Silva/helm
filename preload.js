// The only bridge between the sandboxed UI and Electron. Everything else goes over the
// WebSocket like the phone does. File.path is gone in Electron 44, so drag-drop of files
// asks webUtils for the real path.
// Owner: lane host (B).
const { contextBridge, webUtils, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helmNative', {
  platform: 'electron',
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch { return null; }
  },
  // Screenshot attach (main/capture.js). The host rejects these from any window but the main one.
  captureSources: () => ipcRenderer.invoke('helm:capture-sources'),
  capture: (id, opts) => ipcRenderer.invoke('helm:capture', String(id || ''), { hideSelf: !(opts && opts.hideSelf === false) }),
  captureCrop: (token, rect) => ipcRenderer.invoke('helm:capture-crop', String(token || ''), rect && { x: +rect.x, y: +rect.y, width: +rect.width, height: +rect.height }),
  // Look Sync lining up (ui/shell/chrome.js Background): where the window's content area and its monitor are,
  // in DIPs: { content: {x, y, width, height}, display: {x, y, width, height, scaleFactor} }. Desktop window only.
  placement: () => ipcRenderer.invoke('helm:placement-get'),
  // Top-row hints to Mantle (ui/shell/toprow.js -> main/toprow.js): fire-and-forget, sent in the same task as the
  // change it describes. Desktop window only (main ignores any other sender).
  topRow: (top) => { try { ipcRenderer.send('helm:toprow', top); } catch {} },
  onPlacement: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const fn = (_e, p) => { try { cb(p); } catch {} };
    ipcRenderer.on('helm:placement', fn);
    return () => ipcRenderer.removeListener('helm:placement', fn);
  },
});
