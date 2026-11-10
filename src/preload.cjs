const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workspace', {
  connect: () => ipcRenderer.invoke('moodle:connect'),
  refresh: () => ipcRenderer.invoke('moodle:refresh'),
  environment: () => ipcRenderer.invoke('moodle:environment'),
  openRepository: () => ipcRenderer.invoke('workspace:open-repository'),
  configure: (live, site) => ipcRenderer.invoke('moodle:configure', live, site),
  setCourseVisibility: (scope, id, visible) => ipcRenderer.invoke('workspace:course-visibility', scope, id, visible),
  open: (kind, id) => ipcRenderer.invoke('moodle:open', kind, id),
  onConnected: callback => ipcRenderer.on('moodle:connected', () => callback()),
  onLoginFailed: callback => ipcRenderer.on('moodle:login-failed', (_event, message) => callback(message)),
  assignment: {
    settings: id => ipcRenderer.invoke('moodle:assignment-settings', id),
    edit: id => ipcRenderer.invoke('moodle:edit-assignment', id),
    change: (id, action, title) => ipcRenderer.invoke('moodle:change-assignment', id, action, title),
  },
  composer: {
    load: () => ipcRenderer.invoke('composer:load'),
    save: draft => ipcRenderer.invoke('composer:save', draft),
    openDraft: id => ipcRenderer.invoke('composer:open-draft', id),
    deleteDraft: id => ipcRenderer.invoke('composer:delete-draft', id),
    settings: settings => ipcRenderer.invoke('composer:settings', settings),
    theme: theme => ipcRenderer.invoke('workspace:theme', theme),
    models: () => ipcRenderer.invoke('composer:models'),
    generate: draft => ipcRenderer.invoke('composer:generate', draft),
    chat: history => ipcRenderer.invoke('composer:chat', history),
    sections: courseId => ipcRenderer.invoke('composer:sections', courseId),
    review: draft => ipcRenderer.invoke('composer:review', draft),
  },
});
