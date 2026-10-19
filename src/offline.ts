import "./fonts.css";
export interface OfflineStatus {
  supported: boolean;
  ready: boolean;
  offline: boolean;
  updateAvailable: boolean;
  cacheVersion: string;
  error?: string;
}
let status: OfflineStatus = {
  supported: typeof navigator !== "undefined" && "serviceWorker" in navigator,
  ready: false,
  offline: typeof navigator !== "undefined" ? !navigator.onLine : false,
  updateAvailable: false,
  cacheVersion: "",
};
let registration: ServiceWorkerRegistration | undefined,
  started = false,
  reloadRequested = false;
const listeners = new Set<(state: OfflineStatus) => void>();
const emit = (update: Partial<OfflineStatus>) => {
  status = { ...status, ...update };
  for (const listener of listeners) listener({ ...status });
};
let probeVersion = 0;
async function probeConnection(): Promise<void> {
  const current = ++probeVersion;
  if (!navigator.onLine) {
    emit({ offline: true });
    return;
  }
  try {
    await fetch(new URL("offline-manifest.json", document.baseURI), {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (current === probeVersion) emit({ offline: false });
  } catch {
    if (current === probeVersion) emit({ offline: true });
  }
}
export const getOfflineStatus = (): OfflineStatus => ({ ...status });
export function registerOffline(
  onState: (state: OfflineStatus) => void,
): () => void {
  listeners.add(onState);
  onState({ ...status });
  if (!started) {
    started = true;
    window.addEventListener("online", () => void probeConnection());
    window.addEventListener("offline", () => {
      probeVersion++;
      emit({ offline: true });
    });
    window.addEventListener("focus", () => {
      if (import.meta.env.PROD) void probeConnection();
    });
    if (status.supported && import.meta.env.PROD) {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloadRequested) location.reload();
        else emit({ ready: true });
      });
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "OFFLINE_STATUS")
          emit({
            ready: event.data.ready === true,
            cacheVersion: String(event.data.version ?? ""),
          });
      });
      const scope = new URL(".", document.baseURI);
      navigator.serviceWorker
        .register(new URL("sw.js", scope), {
          scope: scope.pathname,
          updateViaCache: "none",
        })
        .then((reg) => {
          registration = reg;
          if (reg.waiting) emit({ updateAvailable: true });
          const inspect = () => {
            const worker = reg.installing;
            if (worker)
              worker.addEventListener("statechange", () => {
                if (
                  worker.state === "installed" &&
                  navigator.serviceWorker.controller
                )
                  emit({ updateAvailable: true });
                if (worker.state === "redundant" && !reg.active)
                  emit({
                    ready: false,
                    error:
                      "Offline installation did not finish. Reload while connected to retry.",
                  });
              });
          };
          reg.addEventListener("updatefound", inspect);
          inspect();
          return navigator.serviceWorker.ready;
        })
        .then((reg) => {
          emit({ ready: true });
          reg.active?.postMessage({ type: "STATUS" });
          void probeConnection();
        })
        .catch((error) =>
          emit({
            ready: false,
            error:
              error instanceof Error
                ? error.message
                : "Offline installation failed.",
          }),
        );
    } else if (!import.meta.env.PROD)
      emit({
        error:
          "Offline installation is enabled in production builds. Run npm run build and npm start.",
      });
  }
  return () => {
    listeners.delete(onState);
  };
}
export function requestAppUpdate(): void {
  if (registration?.waiting) {
    reloadRequested = true;
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  } else void registration?.update();
}
export async function requestPersistentStorage(): Promise<boolean> {
  return navigator.storage?.persist ? await navigator.storage.persist() : false;
}
export async function getStorageEstimate(): Promise<{
  usage: number;
  quota: number;
  persisted: boolean;
}> {
  const estimate = await navigator.storage?.estimate?.();
  return {
    usage: estimate?.usage ?? 0,
    quota: estimate?.quota ?? 0,
    persisted: (await navigator.storage?.persisted?.()) ?? false,
  };
}
