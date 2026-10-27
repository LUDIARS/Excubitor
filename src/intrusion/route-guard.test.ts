import { describe, it, expect } from 'vitest';
import { assertIntrusionRouteMutation, installIntrusionRouteGuard } from './route-guard.js';

describe('broker intrusion guard', () => {
  it('rejects bypass and latched reopening but leaves unrelated hosts alone', () => {
    let blocked = false;
    const release = installIntrusionRouteGuard(['app.example.com'], 'http://127.0.0.1:9000', () => blocked);
    try {
      expect(() => assertIntrusionRouteMutation('app.example.com', 'http://127.0.0.1:8080')).toThrow();
      expect(() => assertIntrusionRouteMutation('app.example.com', 'http://127.0.0.1:9000')).not.toThrow();
      blocked = true;
      expect(() => assertIntrusionRouteMutation('app.example.com', 'http://127.0.0.1:9000')).toThrow();
      expect(() => assertIntrusionRouteMutation('other.example.com', 'http://127.0.0.1:8080')).not.toThrow();
    } finally { release(); }
  });
});
