const CACHE_VERSION = "tiny-pos-step-46-4-28-global-mobile-input-stability";
const SHELL_CACHE = `${CACHE_VERSION}-app`;
const STATIC_CACHE = `${CACHE_VERSION}-static`;

const APP_SHELL = [
  "/",
  "/offline.html",
  "/manifest.webmanifest",
  "/icons/tiny-pos-192.png",
  "/icons/tiny-pos-512.png",
  "/icons/tiny-pos-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/tiny-pos-brand.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key !== SHELL_CACHE &&
                key !== STATIC_CACHE
            )
            .map((key) => caches.delete(key))
        )
      ),
      self.clients.claim()
    ])
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

function isServerDataRequest(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/.netlify/functions/") ||
    url.pathname.startsWith("/netlify/functions/")
  );
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);

    if (response?.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put("/", response.clone());
    }

    return response;
  } catch {
    return (
      (await caches.match("/")) ||
      (await caches.match("/offline.html"))
    );
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response?.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || network || Response.error();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;
  if (isServerDataRequest(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  const cacheableDestination = [
    "script",
    "style",
    "font",
    "image",
    "manifest"
  ].includes(request.destination);

  if (cacheableDestination) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
