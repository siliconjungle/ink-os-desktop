const {contextBridge, ipcRenderer} = require('electron');
let active = false;
ipcRenderer.on('ink:desktop-active', (_event, value) => {active = value === true;});
// No renderer-to-main channel or general-purpose IPC is exposed to the desktop or app frames.
contextBridge.exposeInMainWorld('inkDesktopGestures', Object.freeze({
  isActive() {return active;},
  onGestureStart(callback) {
    if (typeof callback !== 'function') throw new TypeError('A gesture listener is required');
    const listener = () => callback();
    ipcRenderer.on('ink:desktop-gesture-start', listener);
    return () => ipcRenderer.removeListener('ink:desktop-gesture-start', listener);
  },
  onSwipe(callback) {
    if (typeof callback !== 'function') throw new TypeError('A swipe listener is required');
    const listener = (_event, direction) => {
      if (direction === 'left' || direction === 'right') callback(direction);
    };
    ipcRenderer.on('ink:desktop-swipe', listener);
    return () => ipcRenderer.removeListener('ink:desktop-swipe', listener);
  },
}));
