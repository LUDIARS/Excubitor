/* Only injected by Ex's Viewer gateway; direct service pages are unchanged. */
(() => {
  'use strict';
  const script = document.currentScript;
  if (!(script instanceof HTMLScriptElement)) return;
  const prefix = script.dataset.prefix;
  if (!prefix || !location.pathname.startsWith(prefix + '/')) return;
  const origins = JSON.parse(script.dataset.origins || '{}');
  Object.defineProperty(window, '__EX_VIEWER_BASE__', { value: prefix });

  function mapUrl(value) {
    const raw = String(value);
    if (raw.startsWith('#') || raw.startsWith('/viewer/')) return raw;
    let url;
    try { url = new URL(raw, location.href); } catch { return raw; }
    const isSocket = url.protocol === 'ws:' || url.protocol === 'wss:';
    if ((url.origin === location.origin || (isSocket && url.host === location.host)) && !url.pathname.startsWith('/viewer/')) {
      return (isSocket ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}` : '')
        + prefix + url.pathname + url.search + url.hash;
    }
    const route = origins[url.origin];
    if (!route) return raw;
    const scheme = url.protocol === 'ws:' || url.protocol === 'wss:'
      ? (location.protocol === 'https:' ? 'wss:' : 'ws:') : location.protocol;
    return `${scheme}//${location.host}${route}${url.pathname}${url.search}${url.hash}`;
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    if (input instanceof Request) {
      const mapped = mapUrl(input.url);
      return nativeFetch.call(this, mapped === input.url ? input : new Request(mapped, input), init);
    }
    return nativeFetch.call(this, mapUrl(input), init);
  };
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return nativeOpen.call(this, method, mapUrl(url), ...rest);
  };
  for (const name of ['WebSocket', 'EventSource', 'Worker', 'SharedWorker']) {
    const Original = window[name];
    if (!Original) continue;
    window[name] = new Proxy(Original, {
      construct(Constructor, args, newTarget) {
        args[0] = mapUrl(args[0]);
        return Reflect.construct(Constructor, args, newTarget);
      },
    });
  }
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => beacon(mapUrl(url), data);
  }
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name].bind(history);
    history[name] = (state, unused, url) => original(state, unused, url == null ? url : mapUrl(url));
  }

  // URL-valued DOM properties are mapped before the browser starts a request.
  const attributes = new Set(['src', 'href', 'action', 'poster']);
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    return setAttribute.call(this, name, attributes.has(name.toLowerCase()) ? mapUrl(value) : value);
  };
  for (const [constructor, names] of [
    [HTMLAnchorElement, ['href']], [HTMLImageElement, ['src']], [HTMLScriptElement, ['src']],
    [HTMLLinkElement, ['href']], [HTMLFormElement, ['action']], [HTMLIFrameElement, ['src']],
    [HTMLMediaElement, ['src']], [HTMLVideoElement, ['poster']], [HTMLSourceElement, ['src']],
  ]) {
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, name);
      if (!descriptor?.set || !descriptor.configurable) continue;
      Object.defineProperty(constructor.prototype, name, {
        ...descriptor, set(value) { descriptor.set.call(this, mapUrl(value)); },
      });
    }
  }
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (anchor) anchor.setAttribute('href', anchor.getAttribute('href'));
  }, true);
  document.addEventListener('submit', (event) => {
    if (event.target instanceof HTMLFormElement) event.target.action = mapUrl(event.target.action);
  }, true);

  // Use the same cookie namespace as the server while preserving the app's API.
  const code = prefix.split('/').pop();
  const cookiePrefix = `exv_${code}.`;
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  const encode = (name) => btoa(String.fromCharCode(...new TextEncoder().encode(name)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const decode = (name) => new TextDecoder().decode(Uint8Array.from(
    atob(name.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0)));
  if (cookie?.get && cookie.set && cookie.configurable) {
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      get() {
        return cookie.get.call(this).split(';').map((part) => part.trim())
          .filter((part) => part.startsWith(cookiePrefix)).map((part) => {
            const equal = part.indexOf('=');
            return decode(part.slice(cookiePrefix.length, equal)) + part.slice(equal);
          }).join('; ');
      },
      set(value) {
        const parts = String(value).split(';');
        const first = parts.shift();
        const equal = first.indexOf('=');
        if (equal < 1) return;
        const rest = parts.filter((part) => !/^\s*(path|domain)\s*=/i.test(part));
        const originalPath = parts.find((part) => /^\s*path\s*=/i.test(part))?.split('=').slice(1).join('=').trim();
        const path = originalPath?.startsWith('/') ? originalPath : '/';
        cookie.set.call(this, `${cookiePrefix}${encode(first.slice(0, equal).trim())}${first.slice(equal)}; Path=${prefix}${path};${rest.join(';')}`);
      },
    });
  }

  // A service worker belonging to one app must not take control of the Viewer.
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = () => Promise.reject(new DOMException('Service workers are disabled in Ex Viewer', 'NotSupportedError'));
    navigator.serviceWorker.getRegistrations = async () => [];
    navigator.serviceWorker.getRegistration = async () => undefined;
  }
})();
