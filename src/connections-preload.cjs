const { contextBridge, ipcRenderer } = require('electron');
const request = input => ipcRenderer.invoke('ink:connections', input);
contextBridge.exposeInMainWorld('inkConnections', Object.freeze({
  list: () => request({ action: 'list' }),
  connect: input => request({ action: 'connect', label: input.label, url: input.url, mode: input.mode, ...(input.token ? { token: input.token } : {}) }),
  select: profileId => request({ action: 'select', profileId }),
  credential: (profileId, token, revision) => request({ action: 'credential', profileId, token, revision }),
  upgrade: (profileId, revision) => request({ action: 'upgrade', profileId, revision }),
  remove: (profileId, revision) => request({ action: 'remove', profileId, revision }),
  close: () => request({ action: 'close' }),
  onChanged: callback => { if (typeof callback !== 'function') return () => {}; const listener = () => callback(); ipcRenderer.on('ink:connections-changed', listener); return () => ipcRenderer.removeListener('ink:connections-changed', listener); }
}));
