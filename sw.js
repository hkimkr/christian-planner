const CACHE_NAME = "grace-planner-pages-v8-2-3";
const BASE_URL = new URL("./", self.location.href);
const APP_SHELL = [
  "./",
  "./index.html",
  "./planner.html?v=8.2.3",
  "./app.css?v=8.2.3",
  "./sync-app.js?v=8.2.3",
  "./manifest.webmanifest?v=8.2.3",
  "./icon.png?v=8.2.3",
].map((path) => new URL(path, BASE_URL).href);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() =>
        caches
          .match(event.request)
          .then((cached) => cached || caches.match(new URL("./", BASE_URL).href))
      )
  );
});
