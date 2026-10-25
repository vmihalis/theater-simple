'use strict';
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const base = new URL(process.env.THEATER_DESKTOP_URL || `http://127.0.0.1:${process.env.THEATER_PORT || '43120'}/`);
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || !base.port) throw new Error('Theater desktop requires a loopback HTTP service with an explicit port.');
base.pathname = '/'; base.search = ''; base.hash = '';
const origin = base.origin;
app.setName('Theater Simple');
const dataRoot = path.resolve(process.env.THEATER_DATA_DIR || (process.platform === 'darwin' ? path.join(app.getPath('appData'), 'Theater Simple') : path.resolve(__dirname, '../data')));
process.env.THEATER_DATA_DIR = dataRoot;
const profilePath = path.join(dataRoot, 'desktop-profile');
fs.mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);

let control;
let website;
let websiteGeneration = 0;
let pendingWebsite = null;
let picker = null;
let quitting = false;
let macServer = null;
const projectors = new Set();
const pickerURL = pathToFileURL(path.join(__dirname, 'source-picker.html')).href;

function isControlURL(value) {
  try { const url = new URL(value); return url.origin === origin && ['/', '/index.html'].includes(url.pathname); } catch { return false; }
}
function isLocalOrigin(value) { try { return new URL(value).origin === origin; } catch { return false; } }
function captureDiagnostic(event, details) {
  // Only booleans, fixed reason labels, and error names/codes: never webpage URLs or caption text.
  console.info('[theater-capture]', JSON.stringify({ event, ...details }));
}
function isStageURL(value) {
  try { const url = new URL(value); return url.origin === origin && ['/stage', '/stage.html'].includes(url.pathname); } catch { return false; }
}
function isControlSender(event) {
  return control && !control.isDestroyed() && event.sender === control.webContents && event.senderFrame === control.webContents.mainFrame && isControlURL(event.senderFrame.url);
}
function requireControl(event) { if (!isControlSender(event)) throw new Error('Only the Theater Simple control panel can request this action.'); }
function parseWebsite(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Enter a valid website address.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a complete website address, such as https://example.com.'); }
  if (url.username || url.password) throw new Error('Website addresses must not contain a username or password.');
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS website address.');
  // The local demo is intentionally presentable. Never expose our control or API as remote content.
  const localServiceHost = ['127.0.0.1', 'localhost', 'localhost.', '[::1]'].includes(url.hostname);
  if (localServiceHost && url.port === base.port && !(url.origin === origin && ['/demo', '/demo.html'].includes(url.pathname))) throw new Error('Use the website address, not the Theater Simple control-panel address.');
  return url;
}
function validWebsiteNavigation(value) { try { parseWebsite(value); return true; } catch { return false; } }
function clearPendingWebsite() {
  if (pendingWebsite?.timer) clearTimeout(pendingWebsite.timer);
  pendingWebsite = null;
}
function rejectPicker() { if (picker) picker.finish(null); }
function closeWebsite() {
  ++websiteGeneration;
  clearPendingWebsite();
  if (website && !website.isDestroyed()) website.destroy();
  website = null;
}
function limitTrustedNavigation(win, predicate) {
  win.webContents.on('will-navigate', (event, url) => { if (!predicate(url)) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, url) => { if (!predicate(url)) event.preventDefault(); });
}

async function chooseDesktopSource(request, callback) {
  rejectPicker();
  let sources;
  try { sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 480, height: 270 }, fetchWindowIcons: false }); }
  catch { callback(null); return; }
  if (!control || control.isDestroyed() || request.frame !== control.webContents.mainFrame) { callback(null); return; }
  const win = new BrowserWindow({ width: 880, height: 660, title: 'Choose a presentation window', parent: control, modal: true, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'picker-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'theater-picker' } });
  let finished = false;
  const finish = source => {
    if (finished) return;
    finished = true;
    if (picker?.window === win) picker = null;
    if (!win.isDestroyed()) win.destroy();
    try { callback(source ? { video: source } : null); } catch { /* Requesting frame may have been closed. */ }
  };
  picker = { window: win, sources, finish };
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  limitTrustedNavigation(win, value => value === pickerURL);
  win.on('closed', () => finish(null));
  try { await win.loadFile(path.join(__dirname, 'source-picker.html')); } catch { finish(null); }
}

function configureControlSession(ses) {
  const allowed = (contents, permission, requestingOrigin, details = {}) => {
    if (!contents || contents.isDestroyed()) return false;
    const topURL = contents.getURL();
    const requestURL = details.requestingUrl || requestingOrigin || topURL;
    let sameOrigin = false;
    try { sameOrigin = new URL(requestURL).origin === origin; } catch { return false; }
    if (!sameOrigin || details.isMainFrame === false) return false;
    if (contents === control?.webContents && isControlURL(topURL)) return ['media', 'display-capture', 'fullscreen', 'speaker-selection', 'window-management'].includes(permission);
    return projectors.has(BrowserWindow.fromWebContents(contents)) && isStageURL(topURL) && permission === 'fullscreen';
  };
  ses.setPermissionCheckHandler(allowed);
  ses.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowed(contents, permission, details?.requestingUrl || contents?.getURL(), details)));
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const checks = { controlAlive: !!control && !control.isDestroyed(), framePresent: !!request.frame, mainFrameMatches: !!control && !control.isDestroyed() && request.frame === control.webContents.mainFrame, originMatches: isLocalOrigin(request.securityOrigin), videoRequested: request.videoRequested === true, audioRequested: request.audioRequested === true, pendingWebsite: !!pendingWebsite };
    captureDiagnostic('request', checks);
    if (!checks.controlAlive || !checks.framePresent || !checks.mainFrameMatches || !checks.originMatches || !checks.videoRequested || checks.audioRequested) { captureDiagnostic('denied', { reason: 'request-scope' }); callback(null); return; }
    const selected = pendingWebsite;
    if (!selected) { await chooseDesktopSource(request, callback); return; }
    clearPendingWebsite();
    try {
      await selected.ready;
      if (selected.generation !== websiteGeneration || !website || website.isDestroyed() || request.frame !== control.webContents.mainFrame) { captureDiagnostic('denied', { reason: 'website-changed' }); callback(null); return; }
      // Capture the app-owned website only. Neither the desktop nor another user's window is auto-selected.
      callback({ video: website.webContents.mainFrame });
      captureDiagnostic('granted', { source: 'owned-website' });
    } catch (error) { captureDiagnostic('failed', { reason: 'load-or-grant', errorName: error?.name || 'Error', errorCode: typeof error?.code === 'string' ? error.code : undefined }); try { callback(null); } catch { /* Frame closed while navigating. */ } }
  });
}

function registerIPC(remoteSession) {
  ipcMain.handle('theater:open-website', (event, rawURL) => {
    requireControl(event);
    const url = parseWebsite(rawURL);
    rejectPicker();
    closeWebsite();
    const generation = websiteGeneration;
    const win = new BrowserWindow({ width: 1280, height: 800, title: 'Theater Simple · Website', show: false, autoHideMenuBar: true, backgroundColor: '#101820', webPreferences: { session: remoteSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false, safeDialogs: true } });
    website = win;
    win.removeMenu();
    win.webContents.on('page-title-updated', event => event.preventDefault());
    win.webContents.setWindowOpenHandler(details => {
      // Links which request a new tab remain in the single captured website.
      if (validWebsiteNavigation(details.url)) win.loadURL(details.url).catch(() => {});
      return { action: 'deny' };
    });
    limitTrustedNavigation(win, validWebsiteNavigation);
    win.on('closed', () => { if (website === win) { website = null; ++websiteGeneration; clearPendingWebsite(); } });
    const load = win.loadURL(url.href);
    let loadTimer;
    const ready = Promise.race([load, new Promise((_, reject) => { loadTimer = setTimeout(() => reject(new Error('Website loading timed out.')), 30000); })]).finally(() => clearTimeout(loadTimer));
    ready.catch(() => {}); // The media handler reports failure without an unhandled rejection.
    const timer = setTimeout(() => { if (pendingWebsite?.generation === generation) clearPendingWebsite(); }, 10000);
    pendingWebsite = { generation, ready, timer };
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
    // Return before navigation finishes, keeping the renderer click's transient activation alive.
    return { url: url.href, name: url.hostname, ready: true };
  });
  ipcMain.handle('theater:focus-website', event => { requireControl(event); if (website && !website.isDestroyed()) { website.show(); website.focus(); return true; } return false; });
  ipcMain.handle('theater:close-website', event => { requireControl(event); closeWebsite(); return true; });
  ipcMain.handle('theater:picker-sources', event => {
    if (!picker || event.sender !== picker.window.webContents || event.senderFrame !== picker.window.webContents.mainFrame || event.senderFrame.url !== pickerURL) throw new Error('Invalid window chooser.');
    return picker.sources.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() }));
  });
  ipcMain.handle('theater:picker-choose', (event, id) => {
    if (!picker || event.sender !== picker.window.webContents || event.senderFrame !== picker.window.webContents.mainFrame || event.senderFrame.url !== pickerURL) throw new Error('Invalid window chooser.');
    const source = id === null ? null : picker.sources.find(item => item.id === id);
    if (id !== null && !source) throw new Error('That window is no longer available.');
    picker.finish(source);
    return true;
  });
}

async function createControl() {
  const controlSession = session.fromPartition('persist:theater-control');
  const remoteSession = session.fromPartition('persist:theater-websites');
  remoteSession.setPermissionCheckHandler(() => false);
  remoteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  remoteSession.setDisplayMediaRequestHandler((_request, callback) => callback(null));
  remoteSession.on('will-download', event => event.preventDefault());
  configureControlSession(controlSession);
  registerIPC(remoteSession);
  control = new BrowserWindow({ width: 1440, height: 950, minWidth: 980, minHeight: 650, title: 'Theater Simple', autoHideMenuBar: true, backgroundColor: '#101820', webPreferences: { session: controlSession, preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  control.removeMenu();
  limitTrustedNavigation(control, isControlURL);
  control.webContents.setWindowOpenHandler(details => {
    if (!isStageURL(details.url)) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: { title: 'Theater Simple · Projector', autoHideMenuBar: true, webPreferences: { session: controlSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(__dirname, 'projector-preload.cjs') } } };
  });
  control.webContents.on('did-create-window', (win, details) => {
    if (!isStageURL(details.url)) { win.destroy(); return; }
    projectors.add(win);
    win.removeMenu();
    limitTrustedNavigation(win, isStageURL);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.once('closed', () => projectors.delete(win));
  });
  control.on('closed', () => { control = null; app.quit(); });
  try { await control.loadURL(base.href); }
  catch { dialog.showErrorBox('Theater Simple', 'The local presentation service is not ready. Close this window and open Start Theater.cmd again.'); app.quit(); }
}

async function startMacServer() {
  const serverPath = path.resolve(__dirname, '../server.mjs');
  const ping = async () => {
    try {
      const response = await fetch(new URL('/api/state', origin), { signal: AbortSignal.timeout(700) });
      const state = await response.json();
      if (state?.app !== 'theater-simple') throw new Error('Another application is using Theater Simple’s port 43120.');
      return true;
    } catch (error) {
      if (error.message.includes('Another application')) throw error;
      return false;
    }
  };
  if (await ping()) return;
  const output = fs.openSync(path.join(dataRoot, 'server.log'), 'a');
  const errors = fs.openSync(path.join(dataRoot, 'server-error.log'), 'a');
  try {
    macServer = spawn(process.execPath, [serverPath], {
      cwd: path.dirname(serverPath),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', output, errors],
    });
  } finally { fs.closeSync(output); fs.closeSync(errors); }
  let spawnError;
  macServer.once('error', error => { spawnError = error; });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (spawnError || macServer.exitCode !== null) break;
    if (await ping()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('The local presentation service could not start. Check server-error.log in Library/Application Support/Theater Simple.');
}

if (!app.requestSingleInstanceLock({ origin })) app.quit();
else {
  app.on('second-instance', () => { if (control && !control.isDestroyed()) { if (control.isMinimized()) control.restore(); control.show(); control.focus(); } });
  app.on('before-quit', () => { if (quitting) return; quitting = true; rejectPicker(); closeWebsite(); for (const win of projectors) if (!win.isDestroyed()) win.destroy(); macServer?.kill(); });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => { if (process.platform === 'darwin') await startMacServer(); await createControl(); }).catch(error => { dialog.showErrorBox('Theater Simple', error.message); app.quit(); });
}
