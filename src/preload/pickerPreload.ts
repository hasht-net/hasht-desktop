import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("picker", {
  listServers: () => ipcRenderer.invoke("picker:list-servers"),
  addServer: (url: string, name: string) =>
    ipcRenderer.invoke("picker:add-server", url, name),
  connectExisting: (id: string) => ipcRenderer.invoke("picker:connect-existing", id),
  removeServer: (id: string) => ipcRenderer.invoke("picker:remove-server", id),
  renameServer: (id: string, name: string) =>
    ipcRenderer.invoke("picker:rename-server", id, name),
  openAtLogin: () => ipcRenderer.invoke("picker:open-at-login"),
  setOpenAtLogin: (enabled: boolean) => ipcRenderer.invoke("picker:set-open-at-login", enabled),
});
