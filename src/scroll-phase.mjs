import {createRequire} from 'node:module';

// The packaged addon is ABI stable and used only by the native main process.
// Chromium's synthetic gestureScrollBegin is absent for consumed Mac swipes.
export function nativeScrollGeneration() {
  if (process.platform !== 'darwin') return undefined;
  const native = createRequire(import.meta.url)('./native-scroll.node');
  return () => native.generation();
}
