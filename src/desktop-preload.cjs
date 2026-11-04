const {contextBridge, ipcRenderer} = require('electron');
// No renderer-to-main channel or general-purpose IPC is exposed to the desktop or app frames.
contextBridge.exposeInMainWorld('inkDesktopGestures', Object.freeze({
  onSwipe(callback) {
    if (typeof callback !== 'function') throw new TypeError('A swipe listener is required');
    const listener = (_event, direction) => {
      if (direction === 'left' || direction === 'right') callback(direction);
    };
    ipcRenderer.on('ink:desktop-swipe', listener);
    return () => ipcRenderer.removeListener('ink:desktop-swipe', listener);
  },
}));
