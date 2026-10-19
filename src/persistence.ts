import type { Network } from "./types";
import { validateNetwork } from "./engine";
export interface SavedWorkspace {
  current: Network;
  library: Network[];
  settings?: Record<string, unknown>;
  savedAt: string;
}
const DB_NAME = "metroweave-workspace",
  STORE_NAME = "state";
let database: Promise<IDBDatabase> | undefined;
function open() {
  if (!database)
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(STORE_NAME);
      request.onerror = () => {
        database = undefined;
        reject(request.error || Error("Device storage is unavailable"));
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          database = undefined;
        };
        resolve(db);
      };
      request.onblocked = () =>
        reject(Error("Close other MetroWeave tabs to upgrade device storage."));
    });
  return database;
}
export async function readSavedWorkspace(): Promise<SavedWorkspace | null> {
  const db = await open();
  const value = await new Promise<unknown>((resolve, reject) => {
    const r = db
      .transaction(STORE_NAME)
      .objectStore(STORE_NAME)
      .get("workspace");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  if (!value) return null;
  const raw = value as SavedWorkspace;
  return {
    current: validateNetwork(raw.current),
    library: (raw.library || []).map(validateNetwork),
    settings: raw.settings || {},
    savedAt: raw.savedAt,
  };
}
export async function writeSavedWorkspace(value: SavedWorkspace) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, "workspace");
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error || Error("Could not save the workspace"));
    tx.onabort = () =>
      reject(tx.error || Error("Workspace save was interrupted"));
  });
}
export async function requestDurableStorage() {
  return navigator.storage?.persist ? navigator.storage.persist() : false;
}
export async function storageInformation() {
  const estimate = await navigator.storage?.estimate?.();
  return {
    usage: estimate?.usage || 0,
    quota: estimate?.quota || 0,
    persisted: (await navigator.storage?.persisted?.()) || false,
  };
}
