import {app, BrowserWindow, dialog, Menu, protocol} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isAllowedStudioNavigation} from './security-policy.mjs';

protocol.registerSchemesAsPrivileged([{
  scheme: 'guardian',
  privileges: {standard: true, secure: true, supportFetchAPI: true, stream: true},
}]);

const appUrl = 'guardian://studio/';
let mainWindow;

if (squirrelStartup) {
  app.quit();
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.squirrel.GuardianStudio.GuardianStudio');
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    const desktopDirectory = dirname(fileURLToPath(import.meta.url));
    const appResources = app.isPackaged ? process.resourcesPath : resolve(desktopDirectory, '../..');
    const studioModule = await import(pathToFileURL(join(appResources, 'dist', 'studio.js')).href);
    protocol.handle('guardian', studioModule.createStudioProtocolHandler());
    Menu.setApplicationMenu(null);

    mainWindow = new BrowserWindow({
      title: 'Guardian Studio',
      width: 1440,
      height: 940,
      minWidth: 980,
      minHeight: 680,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        devTools: !app.isPackaged,
      },
    });

    const denyOutsideNavigation = (event, url) => {
      if (!isAllowedStudioNavigation(url, appUrl)) event.preventDefault();
    };
    mainWindow.webContents.on('will-navigate', denyOutsideNavigation);
    mainWindow.webContents.on('will-redirect', denyOutsideNavigation);
    mainWindow.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.on('closed', () => { mainWindow = undefined; });

    await mainWindow.loadURL(appUrl);
  }).catch((error) => {
    dialog.showErrorBox('Guardian Studio could not start', error instanceof Error ? error.message : 'Restart the application and try again.');
    app.quit();
  });

  app.on('window-all-closed', () => app.quit());
}
