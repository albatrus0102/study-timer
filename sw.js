"use strict";

// 캐시 이름에 버전을 포함해 배포할 때마다 올려주면 구버전 캐시가 자동 정리된다.
var CACHE_NAME = "pomodoro-v27";
// 아이패드 오프라인의 생명줄. 하나라도 실패하면 설치가 통째로 깨지므로 최소한만 둔다.
var PRECACHE_URLS = ["./", "./index.html", "./icon.png"];
// 맥 전용. mac.html 과 focus-sensor.js 는 반드시 같은 세대로 묶여야 한다 —
// 런타임 캐시(cache-first)에만 맡기면 배포 직후 구버전 mac.html + 신버전 sensor
// 같은 조합이 나올 수 있다. 다만 실패해도 설치는 계속돼야 하므로 따로 처리한다.
var PRECACHE_OPTIONAL = ["./mac.html", "./focus-sensor.js", "./focus-sensor.js?v=26"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE_URLS).then(function () {
        return Promise.all(PRECACHE_OPTIONAL.map(function (u) {
          return cache.add(u).catch(function () { /* 없으면 런타임 캐시에 맡긴다 */ });
        }));
      });
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
// 맥 전용 파일은 network-first 로 간다. cache-first 로 두면 배포한 코드가 캐시에
// 가려 며칠씩 옛 버전이 돌고, mac.html 은 새것인데 focus-sensor.js 는 구버전인
// 어긋난 조합까지 생긴다(실제로 반복해서 겪었다). 맥은 네트워크가 있는 환경이므로
// 최신을 먼저 받고, 실패하면 캐시로 떨어진다.
// 아이패드(index.html 등)는 오프라인이 생명이라 cache-first 를 그대로 둔다.
var NETWORK_FIRST = ["/mac.html", "/focus-sensor.js"];
function isNetworkFirst(url) {
  return NETWORK_FIRST.some(function (p) { return url.pathname.endsWith(p); });
}

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  // api.github.com 등 다른 오리진 요청은 캐시 대상에서 제외한다 (동기화가 낡은 응답을
  // 재사용하지 않도록). same-origin 요청만 cache-first 로직을 탄다.
  var reqUrl = new URL(event.request.url);
  if (reqUrl.origin !== self.location.origin) return;

  if (isNetworkFirst(reqUrl)) {
    event.respondWith(
      fetch(event.request).then(function (res) {
        if (res && res.ok) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(event.request, clone); });
        }
        return res;
      }).catch(function () {
        return caches.match(event.request);
      })
    );
    return;
  }

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
