"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rangabotDesktop", Object.freeze({
  saveProfileBackup(bytes, filename) {
    if (!(bytes instanceof ArrayBuffer)) return Promise.reject(new Error("The profile backup bytes are invalid."));
    return ipcRenderer.invoke("rangabot:save-profile-backup", { bytes: new Uint8Array(bytes), filename });
  },
}));
