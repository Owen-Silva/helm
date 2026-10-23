// Dev-only Electron window that shows the UI from tools/serve-ui.js in mock mode, so the user can
// watch Helm being built in a real app window (live reload included). The real app is main.js.
// Usage: npx electron tools/dev-window.js [port=4870]
const { app, BrowserWindow } = require('electron');

const port = process.argv.find((a) => /^\d+$/.test(a)) || '4870';
app.setAppUserModelId('com.owensilva.helm.dev');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: 'Helm (dev)', backgroundColor: '#1d1f22', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(`http://127.0.0.1:${port}/?mock=1`);
});
app.on('window-all-closed', () => app.quit());
