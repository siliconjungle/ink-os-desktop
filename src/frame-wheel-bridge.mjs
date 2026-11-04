/** Runs in an app frame with ordinary DOM access only; no Node or IPC exposure. */
export function installFrameWheelBridge() {
  const marker = Symbol.for('ink.workspace.wheel.bridge.v1');
  if (window[marker] || window === window.parent) return;
  window[marker] = true;
  const valid = value => value?.source === 'ink-workspace-wheel' && value.version === 1 &&
    [value.deltaX, value.deltaY].every(number => Number.isFinite(number) && Math.abs(number) <= 100000) &&
    [0, 1, 2].includes(value.deltaMode);
  const post = value => window.parent.postMessage(value, '*');
  window.addEventListener('wheel', event => {
    if (!event.isTrusted) return;
    const value = {source:'ink-workspace-wheel', version:1, deltaX:event.deltaX, deltaY:event.deltaY,
      deltaMode:event.deltaMode, ctrlKey:event.ctrlKey, metaKey:event.metaKey, altKey:event.altKey, shiftKey:event.shiftKey};
    if (!valid(value)) return;
    post(value);
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.5) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, {capture:true, passive:false});
  // A nested frame relays through its owning app; the desktop verifies the direct app frame.
  window.addEventListener('message', event => {
    if (valid(event.data) && [...document.querySelectorAll('iframe')].some(frame => frame.contentWindow === event.source)) post(event.data);
  });
}

export function bindFrameWheelBridge(contents, origin) {
  let disposed = false;
  const cleanups = new Set();
  const trusted = () => {
    try {return !disposed && new URL(contents.getURL()).origin === new URL(origin).origin;} catch {return false;}
  };
  const inject = frame => {
    if (!trusted() || frame === contents.mainFrame) return;
    try {
      if (frame.isDestroyed() || frame.detached) return;
      void frame.executeJavaScript('(' + installFrameWheelBridge.toString() + ')()').catch(() => {});
    } catch {}
  };
  const created = (_event, {frame}) => {
    if (frame === contents.mainFrame) return;
    const ready = () => inject(frame);
    frame.on('dom-ready', ready);
    cleanups.add(() => frame.removeListener('dom-ready', ready));
  };
  contents.on('frame-created', created);
  for (const frame of contents.mainFrame.framesInSubtree) {
    if (frame !== contents.mainFrame) {created(undefined, {frame}); inject(frame);}
  }
  return () => {disposed = true; contents.removeListener('frame-created', created); for (const cleanup of cleanups) cleanup(); cleanups.clear();};
}
