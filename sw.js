"use strict";

// 캐시 이름에 버전을 포함해 배포할 때마다 올려주면 구버전 캐시가 자동 정리된다.
var CACHE_NAME = "pomodoro-v4";
var PRECACHE_URLS = ["./", "./index.html", "./icon.png"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE_URLS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) {
          return key !== CACHE_NAME;
        }).map(function (key) {
          return caches.delete(key);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// cache-first, stale-while-revalidate 스타일: 캐시가 있으면 즉시 응답하고
// 백그라운드에서 네트워크로 갱신을 시도한다. 완전 오프라인(방화벽) 환경에서는
// 네트워크 요청이 그냥 실패하고 캐시 응답만 사용된다.
self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then(function (cachedResponse) {
      var networkFetch = fetch(event.request).then(function (networkResponse) {
        if (networkResponse && networkResponse.ok) {
          var responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(function () {
        return cachedResponse;
      });

      return cachedResponse || networkFetch;
    })
  );
});
