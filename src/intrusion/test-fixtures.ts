import { intrusionConfigSchema } from './config.js';
import type { AccessEvidence } from './detection.js';

export const config = intrusionConfigSchema.parse({ site: 'headquarters', requestsPerMinute: 10,
  authFailuresPerMinute: 2,
  routes: [{ hostname: 'app.example.com', service: 'app', origin: 'http://127.0.0.1:8080' }],
  tunnels: [{ id: 'a4e50a50-1a8e-4ca0-a4bc-b394e95f1271', hostnames: ['app.example.com'] }] });
export const event: AccessEvidence = { at: 1000, service: 'app', hostname: 'app.example.com',
  clientIp: '203.0.113.1', country: 'JP', method: 'GET', path: '/' };
