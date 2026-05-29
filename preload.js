const { contextBridge, ipcRenderer } = require('electron');

// Secure context bridge exposure for custom frame controls
contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  importMusicFolder: () => ipcRenderer.invoke('import-music-folder'),
  selectAudioFolders: () => ipcRenderer.invoke('select-audio-folders')
});
