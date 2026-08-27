import { contextBridge, ipcRenderer } from 'electron'

/** API keys stay in main (spec §5) — the renderer only ever gets these calls. */
const api = {
  permissions: () => ipcRenderer.invoke('perm:check'),
  requestPermissions: () => ipcRenderer.invoke('perm:request'),
  openPrivacySettings: (which: 'screen' | 'microphone') => ipcRenderer.invoke('perm:open', which),
  start: (title: string) => ipcRenderer.invoke('session:start', title),
  pcm: (track: 'loopback' | 'mic', pcm: ArrayBuffer) => ipcRenderer.invoke('session:pcm', track, pcm),
  stop: () => ipcRenderer.invoke('session:stop'),
  reveal: (dir: string) => ipcRenderer.invoke('shell:reveal', dir),
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
