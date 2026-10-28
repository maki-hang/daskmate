// Preserve the existing UI contract while moving every privileged action to Rust.
(() => {
  if (!window.__TAURI__) return;
  const { invoke, convertFileSrc } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const registrations = [];
  const normalize = value => {
    if (value?.skins) for (const skin of value.skins) for (const [key, file] of Object.entries(skin.states)) {
      if (!/^(https?:|asset:|data:)/.test(file)) skin.states[key] = convertFileSrc(file);
    }
    return value;
  };
  window.assistant = {
    call: async (action, value = {}) => {
      await Promise.all(registrations);
      try { return normalize(await invoke('assistant_call', { action, value })); }
      catch (error) { throw error instanceof Error ? error : new Error(error?.message || String(error)); }
    },
    on: (event, callback) => {
      if (!['changed', 'usage', 'reminder', 'navigate'].includes(event)) return;
      const ready = listen('assistant:' + event, message => callback(normalize(message.payload)));
      registrations.push(ready);
      return () => ready.then(unlisten => unlisten());
    }
  };
  let previousTarget = null;
  registrations.push(listen('assistant:pointer', ({ payload: { x, y } }) => {
    const target = document.elementFromPoint(x, y)?.closest('[data-interactive]');
    if (previousTarget !== target) {
      previousTarget?.dispatchEvent(new PointerEvent('pointerleave'));
      target?.dispatchEvent(new PointerEvent('pointerenter'));
      previousTarget = target;
    }
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) document.documentElement.dispatchEvent(new PointerEvent('pointerleave'));
    else document.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
  }));
  document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(() => requestAnimationFrame(() => window.assistant.call('window.ready').catch(console.error))));
})();
