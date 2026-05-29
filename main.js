const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 1000,
    minHeight: 700,
    frame: false, // Frameless window for our custom industrial design UI
    transparent: true, // Enables transparent panels and rounded edges
    hasShadow: true,
    show: false, // Don't show until ready to prevent flashing
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webgl: true // Hardware acceleration active for Canvas stroboscope and radial waveform
    },
    backgroundColor: '#00000000' // Translucent background
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Window Management IPC Handlers
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('import-music-folder', async () => {
  const musicPath = path.join(os.homedir(), 'Music');
  return readAudioFilesFromFolders([musicPath]);
});

ipcMain.handle('select-audio-folders', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose music folders',
    properties: ['openDirectory', 'multiSelections']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return {
      folders: [],
      files: []
    };
  }

  return readAudioFilesFromFolders(result.filePaths);
});

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.aiff']);
const MAX_IMPORTED_FILES = 200;

async function readAudioFilesFromFolders(folderPaths) {
  const files = [];
  const folderSummaries = folderPaths.map(folderPath => ({
    path: folderPath,
    name: path.basename(folderPath) || folderPath
  }));

  for (const folderPath of folderPaths) {
    await collectAudioFiles(folderPath, files);
    if (files.length >= MAX_IMPORTED_FILES) break;
  }

  const filePayloads = [];
  for (const filePath of files.slice(0, MAX_IMPORTED_FILES)) {
    const bytes = await fs.readFile(filePath);
    filePayloads.push({
      name: path.basename(filePath),
      path: filePath,
      bytes: new Uint8Array(bytes)
    });
  }

  return {
    folders: folderSummaries,
    files: filePayloads,
    truncated: files.length > MAX_IMPORTED_FILES
  };
}

async function collectAudioFiles(folderPath, files) {
  if (files.length >= MAX_IMPORTED_FILES) return;

  let entries;
  try {
    entries = await fs.readdir(folderPath, { withFileTypes: true });
  } catch (error) {
    console.warn('Unable to scan music folder:', folderPath, error.message);
    return;
  }

  for (const entry of entries) {
    if (files.length >= MAX_IMPORTED_FILES) return;
    const entryPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      await collectAudioFiles(entryPath, files);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }
}

// App Initializations
app.whenReady().then(() => {
  // Enable custom hardware acceleration options
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
