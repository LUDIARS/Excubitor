/* Namespace browser storage for the current Viewer service, including clear(). */
(() => {
  'use strict';
  const script = document.currentScript;
  const prefix = script?.dataset.prefix;
  if (!prefix || !location.pathname.startsWith(prefix + '/')) return;
  for (const name of ['localStorage', 'sessionStorage']) {
    const storage = window[name];
    const namespace = `ex-viewer:${prefix}:`;
    const keys = () => Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key) => key !== null && key.startsWith(namespace)).map((key) => key.slice(namespace.length));
    const methods = {
      getItem: (key) => storage.getItem(namespace + String(key)),
      setItem: (key, value) => storage.setItem(namespace + String(key), String(value)),
      removeItem: (key) => storage.removeItem(namespace + String(key)),
      clear: () => { for (const key of keys()) storage.removeItem(namespace + key); },
      key: (index) => keys()[Number(index)] ?? null,
    };
    const scoped = new Proxy(Object.create(Storage.prototype), {
      get(_target, key) {
        if (key === 'length') return keys().length;
        if (Object.hasOwn(methods, key)) return methods[key];
        if (key === Symbol.toStringTag) return 'Storage';
        return typeof key === 'string' ? methods.getItem(key) ?? undefined : undefined;
      },
      set(_target, key, value) { if (typeof key === 'string') methods.setItem(key, value); return true; },
      deleteProperty(_target, key) { if (typeof key === 'string') methods.removeItem(key); return true; },
      ownKeys: keys,
      has(_target, key) { return typeof key === 'string' && methods.getItem(key) !== null; },
      getOwnPropertyDescriptor(_target, key) {
        if (typeof key !== 'string' || methods.getItem(key) === null) return undefined;
        return { configurable: true, enumerable: true, writable: true, value: methods.getItem(key) };
      },
    });
    Object.defineProperty(window, name, { configurable: true, get: () => scoped });
  }
})();
