// 预加载脚本：向渲染进程暴露安全 API
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('island', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  setExpanded: (v) => ipcRenderer.invoke('ui:setExpanded', v),
  activity: () => ipcRenderer.invoke('ui:activity'),
  startDrag: () => ipcRenderer.invoke('ui:startDrag'),
  drag: () => ipcRenderer.invoke('ui:drag'),
  endDrag: () => ipcRenderer.invoke('ui:endDrag'),
  pasteImage: () => ipcRenderer.invoke('chat:pasteImage'),
  pasteFiles: () => ipcRenderer.invoke('chat:pasteFiles'),

  sendText: (peer, text) => ipcRenderer.invoke('lan:sendText', { peer, text }),
  sendFiles: (peer, files) => ipcRenderer.invoke('lan:sendFiles', { peer, files }),

  chatHistory: (peerId) => ipcRenderer.invoke('chat:history', peerId),
  chatAllPeers: () => ipcRenderer.invoke('chat:allPeers'),
  chatClear: (peerId) => ipcRenderer.invoke('chat:clear', peerId),

  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  stagingList: () => ipcRenderer.invoke('staging:list'),
  stagingAdd: () => ipcRenderer.invoke('staging:add'),
  stagingAddPaths: (paths) => ipcRenderer.invoke('staging:addPaths', paths),
  stagingRemove: (idx) => ipcRenderer.invoke('staging:remove', idx),
  stagingClear: () => ipcRenderer.invoke('staging:clear'),
  stagingOpenReceived: () => ipcRenderer.invoke('staging:openReceived'),

  notesList: () => ipcRenderer.invoke('notes:list'),
  notesAdd: (text, color) => ipcRenderer.invoke('notes:add', { text, color }),
  notesSetColor: (id, color) => ipcRenderer.invoke('notes:setColor', { id, color }),
  notesUpdate: (id, text) => ipcRenderer.invoke('notes:update', { id, text }),
  notesDelete: (id) => ipcRenderer.invoke('notes:delete', id),
  notesTop: (id) => ipcRenderer.invoke('notes:top', id),

  clipList: () => ipcRenderer.invoke('clip:list'),
  clipCopy: (item) => ipcRenderer.invoke('clip:copy', item),
  clipClear: () => ipcRenderer.invoke('clip:clear'),

  musicList: () => ipcRenderer.invoke('music:list'),
  musicAddFolder: () => ipcRenderer.invoke('music:addFolder'),
  musicAddFiles: () => ipcRenderer.invoke('music:addFiles'),
  musicRemove: (idx) => ipcRenderer.invoke('music:remove', idx),
  musicClear: () => ipcRenderer.invoke('music:clear'),
  musicOpenUrl: (url) => ipcRenderer.invoke('music:openUrl', url),
  musicLyrics: (p) => ipcRenderer.invoke('music:lyrics', p),
  musicSetOffset: (p) => ipcRenderer.invoke('music:setOffset', p),
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  scInstalled: () => ipcRenderer.invoke('sc:installed'),
  scList: () => ipcRenderer.invoke('sc:list'),
  scAdd: (paths) => ipcRenderer.invoke('sc:add', paths),
  scPick: (type) => ipcRenderer.invoke('sc:pick', type),
  scRemove: (id) => ipcRenderer.invoke('sc:remove', id),
  scOpen: (id) => ipcRenderer.invoke('sc:open', id),

  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),

  memInfo: () => ipcRenderer.invoke('mem:info'),
  memGc: () => ipcRenderer.invoke('mem:gc'),

  openPath: (p) => ipcRenderer.invoke('app:openPath', p),
  notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),
  quit: () => ipcRenderer.invoke('app:quit'),

  // 拖拽文件取真实路径
  pathForFile: (file) => webUtils.getPathForFile(file),

  onPeers: (cb) => ipcRenderer.on('lan:peers', (e, list) => cb(list)),
  onMessage: (cb) => ipcRenderer.on('lan:message', (e, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('lan:progress', (e, p) => cb(p)),
  onExpanded: (cb) => ipcRenderer.on('ui:expanded', (e, v) => cb(v)),
  onEdgeHidden: (cb) => ipcRenderer.on('ui:edgeHidden', (e, edge) => cb(edge)),
  onAgentStatus: (cb) => ipcRenderer.on('ui:agentStatus', (e, s) => cb(s)),
  onClip: (cb) => ipcRenderer.on('clip:update', (e, list) => cb(list)),
});
