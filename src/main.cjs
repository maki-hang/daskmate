const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, Notification, shell, screen, powerMonitor, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Store, saveNote, saveReminder, saveAgenda } = require('./core/store.cjs');
const { collectDue } = require('./core/reminders.cjs');
const { GitIndex, discover, disposeGit } = require('./core/git.cjs');
const { AGENTS, UsageService, disposeUsage } = require('./core/usage.cjs');
const { importSkin, allSkins } = require('./core/skins.cjs');
const { UpdateService, translatedUrl } = require('./core/updates.cjs');
const { t, locales } = require('./renderer/i18n.js');
const tr = (key) => t(key, store?.state.settings.language || 'zh-CN');

const { dataDirectory } = require('./core/data-directory.cjs');
const { PetDrag, PET_BOUNDS, clampPetPosition } = require('./core/pet-drag.cjs');
app.setName('DeskMate');
app.setAppUserModelId('com.deskmate.pc-assistant');
app.setPath('userData', dataDirectory(app.getPath('appData')));
if (!app.requestSingleInstanceLock()) app.quit();
let store, gitIndex, usage, updates, pet, panel, tray, petDrag, quitting = false, positionTimer, lastReminder = null;
const notifications = new Set();
const renderer = path.join(__dirname, 'renderer');
function broadcast(channel, data) {
  for (const win of [pet, panel]) if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}
function state() { return { ...store.state, skins: allSkins(store), agents: AGENTS, dataDirectory: store.directory, recovered: store.recovered, packaged: app.isPackaged, lastReminder }; }
function changed() { broadcast('assistant:changed', state()); }
function secureWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
}
function openPanel(page) {
  if (!panel || panel.isDestroyed()) {
    panel = new BrowserWindow({ width: 1120, height: 820, minWidth: 900, minHeight: 670, show: false, title: tr('appTitle'), icon: path.resolve(__dirname, '../build/icon.png'), backgroundColor: '#f5f5f0', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    secureWindow(panel);
    panel.loadFile(path.join(renderer, 'index.html'));
    panel.once('ready-to-show', () => { panel.show(); if (page) panel.webContents.send('assistant:navigate', page); });
    panel.on('close', e => { if (!quitting) { e.preventDefault(); panel.hide(); } });
  } else { panel.show(); panel.focus(); if (page) panel.webContents.send('assistant:navigate', page); }
}
function trayIcon() {
  // Code-generated RGBA icon, no third-party art dependency.
  const size = 32, pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, inside = (x - 15.5) ** 2 + (y - 15.5) ** 2 < 225;
    const outer = ((x-14)/9)**2 + ((y-15.5)/10)**2 <= 1, inner = ((x-14)/5)**2 + ((y-15.5)/6)**2 < 1;
    const white = (x >= 7 && x <= 10 && y >= 6 && y <= 25) || (x >= 10 && outer && !inner);
    pixels.set(white ? [241, 255, 248, 255] : [58, 120, 93, inside ? 255 : 0], i);
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}
function petMenu() {
  return Menu.buildFromTemplate([
    { label: tr('openApp'), click: () => openPanel() },
    { label: tr('switchAgent'), submenu: AGENTS.map(a => ({ label: a.name, type: 'radio', checked: store.state.settings.agent === a.id, click: () => { store.update(s => { s.settings.agent = a.id; }); tray.setContextMenu(petMenu()); changed(); refreshUsage(); } })) },
    { label: tr('petQuotaDisplay'), submenu: ['always', 'hover'].map(mode => ({ label: tr(mode === 'hover' ? 'quotaHover' : 'quotaAlways'), type: 'radio', checked: (store.state.settings.petQuotaDisplay === 'hover' ? 'hover' : 'always') === mode, click: () => handle('settings', { petQuotaDisplay: mode }) })) },
    { label: tr('agenda'), click: () => openPanel('agenda') },
    { label: tr('settings'), click: () => openPanel('settings') }, { type: 'separator' },
    { label: tr('showPet'), click: () => pet.show() }, { label: tr('hidePet'), click: () => pet.hide() },
    { label: tr('quit'), click: () => { quitting = true; app.quit(); } }
  ]);
}
async function refreshUsage(force = false) {
  const agent = store.state.settings.agent;
  const value = await usage.read(agent, force);
  if (agent === store.state.settings.agent) broadcast('assistant:usage', value);
  return value;
}
function tickReminders() {
  if (!store) return;
  const fired = collectDue(store);
  for (const item of fired) {
    lastReminder = { title: item.title, id: item.id, at: new Date().toISOString() };
    if (Notification.isSupported()) {
      const notification = new Notification({ title: tr('reminderTitle'), body: item.title, timeoutType: 'never' });
      notifications.add(notification);
      notification.on('click', () => openPanel('agenda'));
      notification.on('close', () => notifications.delete(notification));
      notification.on('failed', () => notifications.delete(notification));
      notification.show();
    }
    pet.show(); broadcast('assistant:reminder', lastReminder);
  }
  if (fired.length) changed();
}
const links = {
  codex: 'https://chatgpt.com/codex/settings/usage',
  claude: 'https://claude.ai/settings/usage',
  artwork: 'https://github.com/fywdy/chatgpt-chibi-pets',
  documentation: 'https://code.claude.com/docs/en/statusline'
};
async function handle(action, value = {}) {
  switch (action) {
    case 'state': return state();
    case 'usage': return refreshUsage(Boolean(value.force));
    case 'updates': return updates.read(value.agent || store.state.settings.agent, Boolean(value.force));
    case 'updates.open': {
      const release = await updates.read(value.agent || store.state.settings.agent);
      if (!release.url) throw new Error('releaseUnavailable');
      await shell.openExternal(translatedUrl(release.url, value.original ? 'en' : store.state.settings.language)); return true;
    }
    case 'panel': openPanel(value.page); return true;
    case 'menu': petMenu().popup({ window: pet }); return true;
    case 'settings': {
      store.update(s => {
        if (value.language !== undefined) { if (!locales.includes(value.language)) throw new Error('invalidLanguage'); s.settings.language = value.language; }
        if (value.agent !== undefined) { if (!AGENTS.some(a => a.id === value.agent)) throw new Error('未知 Agent'); s.settings.agent = value.agent; }
        if (value.alwaysOnTop !== undefined) s.settings.alwaysOnTop = Boolean(value.alwaysOnTop);
        if (value.petQuotaDisplay !== undefined) {
          if (!['always', 'hover'].includes(value.petQuotaDisplay)) throw new Error('invalidQuotaDisplay');
          s.settings.petQuotaDisplay = value.petQuotaDisplay;
        }
        if (value.skinId !== undefined) {
          if (!allSkins(store).some(a => a.id === value.skinId)) throw new Error('形象不存在');
          const agent = value.skinAgent || s.settings.agent;
          if (!AGENTS.some(a => a.id === agent)) throw new Error('未知 Agent');
          s.settings.skins[agent] = value.skinId;
        }
        if (value.launchAtLogin !== undefined) {
          if (!app.isPackaged) throw new Error('开机启动需使用打包后的桌面版。');
          app.setLoginItemSettings({ openAtLogin: Boolean(value.launchAtLogin) }); s.settings.launchAtLogin = Boolean(value.launchAtLogin);
        }
      });
      pet.setAlwaysOnTop(store.state.settings.alwaysOnTop); panel?.setTitle(tr('appTitle')); tray.setToolTip(tr('appTitle')); tray.setContextMenu(petMenu()); changed();
      if (value.agent) refreshUsage();
      return state();
    }
    case 'agenda.save': { const result = saveAgenda(store, value); if (lastReminder && !store.state.reminders.some(r => r.id === lastReminder.id && r.unread)) lastReminder = null; changed(); tickReminders(); return result; }
    case 'note.save': { const result = saveNote(store, value); changed(); return result; }
    case 'note.delete': store.update(s => { s.notes = s.notes.filter(n => n.id !== value.id); s.reminders = s.reminders.filter(r => r.noteId !== value.id); }); if (lastReminder && !store.state.reminders.some(r => r.id === lastReminder.id)) lastReminder = null; changed(); return true;
    case 'reminder.save': { const result = saveReminder(store, value); changed(); tickReminders(); return result; }
    case 'reminder.delete': store.update(s => { s.reminders = s.reminders.filter(n => n.id !== value.id); }); changed(); return true;
    case 'reminder.toggle': store.update(s => { const r = s.reminders.find(n => n.id === value.id); if (r) { r.enabled = !r.enabled; if (r.enabled) r.completed = false; } }); changed(); tickReminders(); return true;
    case 'reminder.snooze': store.update(s => { const r = s.reminders.find(n => n.id === value.id); if (r) { r.dueAt = new Date(Date.now() + 10 * 60000).toISOString(); r.enabled = true; r.completed = false; r.unread = false; } }); lastReminder = null; changed(); return true;
    case 'reminder.ack': store.update(s => { for (const r of s.reminders) r.unread = false; }); lastReminder = null; changed(); return true;
    case 'git.add': {
      const result = await dialog.showOpenDialog(panel, { title: tr(value.scan ? 'selectScan' : 'selectRepo'), properties: ['openDirectory'] });
      if (result.canceled) return { canceled: true };
      const discovery = value.scan ? await discover(result.filePaths[0]) : { found: result.filePaths, warnings: [] };
      let added = 0; const errors = [];
      for (const directory of discovery.found) try { const before = store.state.repositories.length; await gitIndex.add(directory); added += store.state.repositories.length - before; } catch { errors.push(directory); }
      await gitIndex.sync(); changed(); return { added, errors, warnings: discovery.warnings };
    }
    case 'git.sync': await gitIndex.sync(); changed(); return state().repositories;
    case 'git.query': return gitIndex.query(value);
    case 'git.remove': store.update(s => { s.repositories = s.repositories.filter(r => r.id !== value.id); }); changed(); return true;
    case 'skin.import': {
      const result = await dialog.showOpenDialog(panel, { title: tr('selectSkin'), properties: ['openFile'], filters: [{ name: tr('skinFiles'), extensions: ['json'] }] });
      if (result.canceled) return null;
      const skin = await importSkin(store, result.filePaths[0]); changed(); return skin;
    }
    case 'codex.path': {
      const result = await dialog.showOpenDialog(panel, { title: tr('selectCodex'), properties: ['openFile'] });
      if (result.canceled) return false;
      store.update(s => { s.settings.codexPath = result.filePaths[0]; }); changed(); return true;
    }
    case 'data.open': await shell.openPath(store.directory); return true;
    case 'readme.open': { const file = store.state.settings.language === 'en' ? 'README.en.md' : store.state.settings.language === 'ja' ? 'README.ja.md' : 'README.md'; await shell.openPath(app.isPackaged ? path.join(process.resourcesPath, file) : path.resolve(__dirname, '..', file)); return true; }
    case 'external': if (!links[value.key]) throw new Error('未知链接'); await shell.openExternal(links[value.key]); return true;
    default: throw new Error('未知操作');
  }
}
app.whenReady().then(() => {
  store = new Store(app.getPath('userData')); gitIndex = new GitIndex(store); usage = new UsageService(store); updates = new UpdateService(store, (...args) => net.fetch(...args));
  if (!store.state.settings.language) store.update(s => { const locale = app.getLocale(); s.settings.language = locale.startsWith('ja') ? 'ja' : locale.startsWith('en') ? 'en' : 'zh-CN'; });
  const bounds = screen.getPrimaryDisplay().workArea;
  const saved = store.state.settings.position;
  // The saved window origin can be off-screen when the pet is against an edge.
  const display = saved ? screen.getDisplayNearestPoint({ x: saved.x + PET_BOUNDS.x + Math.floor(PET_BOUNDS.width / 2), y: saved.y + PET_BOUNDS.y + Math.floor(PET_BOUNDS.height / 2) }).workArea : bounds;
  const pos = saved ? clampPetPosition(saved, display) : { x: bounds.x + bounds.width - 260, y: bounds.y + bounds.height - 390 };
  pet = new BrowserWindow({ ...pos, width: 260, height: 360, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: store.state.settings.alwaysOnTop, hasShadow: false, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  secureWindow(pet); pet.loadFile(path.join(renderer, 'pet.html')); pet.once('ready-to-show', () => { pet.setIgnoreMouseEvents(true, { forward: true }); pet.show(); });
  const savePetPosition = () => { clearTimeout(positionTimer); if (quitting || pet.isDestroyed()) return; const [x, y] = pet.getPosition(); store.update(s => { s.settings.position = { x, y }; }); };
  petDrag = new PetDrag(pet, screen, savePetPosition);
  pet.on('moved', () => { clearTimeout(positionTimer); positionTimer = setTimeout(savePetPosition, 600); });
  pet.on('blur', () => petDrag.end());
  pet.on('hide', () => petDrag.end());
  tray = new Tray(trayIcon()); tray.setToolTip(tr('appTitle')); tray.setContextMenu(petMenu()); tray.on('click', () => openPanel());
  ipcMain.handle('assistant:call', async (event, action, value) => {
    if (![pet?.webContents, panel?.webContents].includes(event.sender) || event.senderFrame !== event.sender.mainFrame) return { error: '不允许的请求' };
    try {
      if (action === 'pet.pointer') {
        if (event.sender !== pet.webContents || typeof value?.interactive !== 'boolean') throw new Error('不允许的请求');
        // Transparent padding and the hidden hover card must not block the desktop.
        pet.setIgnoreMouseEvents(!petDrag.active && !value.interactive, { forward: true });
        return { result: true };
      }
      if (action === 'pet.drag.start' || action === 'pet.drag.end') {
        if (event.sender !== pet.webContents) throw new Error('不允许的请求');
        if (action === 'pet.drag.start') petDrag.start(); else petDrag.end();
        return { result: true };
      }
      return { result: await handle(action, value) };
    } catch (e) { return { error: e.message }; }
  });
  openPanel();
  for (const a of AGENTS) updates.read(a.id).catch(() => {});
  setInterval(() => { for (const a of AGENTS) updates.read(a.id).catch(() => {}); }, 6*3600000);
  refreshUsage(); gitIndex.sync().then(changed).catch(() => {});
  setInterval(() => refreshUsage().catch(() => {}), 60000);
  setInterval(() => gitIndex.sync().then(changed).catch(() => {}), 60000);
  setInterval(tickReminders, 1000); setTimeout(tickReminders, 2500);
  powerMonitor.on('resume', () => { tickReminders(); refreshUsage(true); });
}).catch(e => { dialog.showErrorBox('桌伴启动失败', e.message); app.quit(); });
app.on('second-instance', () => openPanel());
app.on('window-all-closed', () => {});
app.on('activate', () => openPanel());
app.on('before-quit', () => { petDrag?.end(); quitting = true; clearTimeout(positionTimer); disposeUsage(); disposeGit(); });
