const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workspace', {
  connect: () => ipcRenderer.invoke('moodle:connect'),
  refresh: () => ipcRenderer.invoke('moodle:refresh'),
  environment: () => ipcRenderer.invoke('moodle:environment'),
  openRepository: () => ipcRenderer.invoke('workspace:open-repository'),
  configure: (live, site) => ipcRenderer.invoke('moodle:configure', live, site),
  setMoodleReadOnly: readOnly => ipcRenderer.invoke('moodle:read-only', readOnly),
  forgetMoodleSession: () => ipcRenderer.invoke('moodle:forget-session'),
  setCourseVisibility: (scope, id, visible) => ipcRenderer.invoke('workspace:course-visibility', scope, id, visible),
  setCourseColor: (scope, id, color) => ipcRenderer.invoke('workspace:course-color', scope, id, color),
  open: (kind, id) => ipcRenderer.invoke('moodle:open', kind, id),
  onConnected: callback => ipcRenderer.on('moodle:connected', () => callback()),
  onLoginFailed: callback => ipcRenderer.on('moodle:login-failed', (_event, message) => callback(message)),
  sectionBuilder: {
    listDecks: () => ipcRenderer.invoke('section:list-decks'),
    build: draft => ipcRenderer.invoke('section:build', draft),
    open: id => ipcRenderer.invoke('section:open', id),
    onProgress: callback => ipcRenderer.on('section:progress', (_event, message) => callback(message)),
  },
  presentations: {
    prepare: history => ipcRenderer.invoke('presentation:prepare', history),
    review: (id, includeImages) => ipcRenderer.invoke('presentation:review', id, includeImages),
    findImages: (id, revision, index, query) => ipcRenderer.invoke('presentation:find-images', id, revision, index, query),
    revise: (id, revision, index, instruction, includeImages) =>
      ipcRenderer.invoke('presentation:revise', id, revision, index, instruction, includeImages),
    update: (id, revision, operation, includeImages) =>
      ipcRenderer.invoke('presentation:update', id, revision, operation, includeImages),
    create: (id, includeImages) => ipcRenderer.invoke('presentation:create', id, includeImages),
    open: (id, kind, sourceId) => ipcRenderer.invoke('presentation:open', id, kind, sourceId),
    onProgress: callback => ipcRenderer.on('presentation:progress', (_event, message) => callback(message)),
  },
  google: {
    status: () => ipcRenderer.invoke('google:status'),
    importClient: () => ipcRenderer.invoke('google:import'),
    connect: () => ipcRenderer.invoke('google:connect'),
    cancel: () => ipcRenderer.invoke('google:cancel'),
    disconnect: () => ipcRenderer.invoke('google:disconnect'),
    setup: () => ipcRenderer.invoke('google:setup'),
  },
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
    chat: async (history, onText) => {
      const requestId = crypto.randomUUID();
      const listener = (_event, id, text) => {
        if (id === requestId) onText(text);
      };
      ipcRenderer.on('composer:chat-text', listener);
      try {
        return await ipcRenderer.invoke('composer:chat', history, requestId);
      } finally {
        ipcRenderer.removeListener('composer:chat-text', listener);
      }
    },
    sections: courseId => ipcRenderer.invoke('composer:sections', courseId),
    review: draft => ipcRenderer.invoke('composer:review', draft),
  },
});
