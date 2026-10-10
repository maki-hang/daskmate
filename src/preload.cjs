const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('assistant', {
  call: async (action, value) => { const r = await ipcRenderer.invoke('assistant:call', action, value); if (r.error) throw new Error(r.error); return r.result; },
  on: (event, callback) => {
    if (!['changed', 'usage', 'reminder', 'navigate'].includes(event)) return;
    const listener = (_, data) => callback(data); ipcRenderer.on('assistant:' + event, listener);
    return () => ipcRenderer.removeListener('assistant:' + event, listener);
  }
});
