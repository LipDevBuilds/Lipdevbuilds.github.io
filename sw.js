// MacroMind service worker — the part of the app that is awake when the app is not.
//
// One job: receive a push from the coach and decide where it goes.
//   - App CLOSED or in the background  -> a real iOS notification (Lock Screen, banner, badge).
//   - App OPEN and on screen           -> handed to the page, which files it in the coach's inbox
//                                         and shows the same small in-app bar it already uses.
// That split is the whole point. The user asked for no notifications while inside the app beyond
// the bar that already exists, and for the coach to be able to reach them when the app is shut.
const SW_VERSION = "2026-09-16.1";

self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

// Is any window of this app actually on screen right now? Not "open somewhere in the switcher" —
// visible. A backgrounded PWA reports "hidden", which is exactly when a notification is wanted.
async function visibleClient() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.find((c) => c.visibilityState === "visible") || null;
}

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: "Coach", body: e.data ? e.data.text() : "" }; }
  const title = data.title || "Coach";
  const body = data.body || "";
  const kind = data.kind || "coach";
  const id = data.id || (kind + ":" + Date.now());
  e.waitUntil((async () => {
    const vis = await visibleClient();
    if (vis) {
      // In the app: no OS notification. The page shows its own bar and files the note.
      vis.postMessage({ type: "coach-push", id, kind, title, body, tab: data.tab || "coach" });
      return;
    }
    if (data.badge != null && self.navigator && "setAppBadge" in self.navigator) {
      try { await self.navigator.setAppBadge(Number(data.badge) || 0); } catch {}
    }
    await self.registration.showNotification(title, {
      body,
      tag: id,                 // same id replaces rather than stacks
      renotify: false,
      icon: "icon-192.png",
      badge: "icon-192.png",
      data: { id, kind, tab: data.tab || "coach", url: data.url || "./" },
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = new URL(d.url || "./", self.location.href);
    target.hash = "#coach:" + encodeURIComponent(d.id || "");
    for (const c of all) {
      if ("focus" in c) {
        await c.focus();
        c.postMessage({ type: "coach-open", id: d.id, kind: d.kind, tab: d.tab });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target.href);
  })());
});

// The page asks the worker its version so a stale worker can be noticed in Settings.
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "sw-version" && e.source) e.source.postMessage({ type: "sw-version", v: SW_VERSION });
});
