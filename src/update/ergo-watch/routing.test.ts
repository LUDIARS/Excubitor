import { describe, expect, it } from 'vitest';

import routeContract from './contracts/route-events.contract.js';
import { hostPrivacyByCode, routeEvents } from './routing.js';
import { sampleEvents, sampleReport } from './test-fixtures.js';

const host = (dir: string, isPrivate: boolean) => ({ dir, serviceCodes: ['svc'], private: isPrivate });

describe('routeEvents', () => {
  it('keeps private dependencies off the public channel', () => {
    const events = sampleEvents().events;
    const privacy = hostPrivacyByCode([{ host: host('/w/ln', false), report: sampleReport('Ln') }]);
    const routed = routeEvents(events, privacy);
    expect(routed.public.map((event) => event.kind)).toEqual(['tag', 'track', 'review']);
    expect(routed.private.map((event) => event.kind)).toEqual(['run']);
    expect(routeContract.post(routed, events, privacy)).toBe(true);
  });

  it('sends everything from a private host to the private channel', () => {
    const events = sampleEvents().events;
    const privacy = hostPrivacyByCode([{ host: host('/w/ln', true), report: sampleReport('Ln') }]);
    const routed = routeEvents(events, privacy);
    expect(routed.public).toEqual([]);
    expect(routed.private).toHaveLength(events.length);
  });

  it('treats a host code without a matching checkout as private', () => {
    const events = sampleEvents().events;
    const privacy = hostPrivacyByCode([{ host: host('/w/ln', false), report: null }]);
    const routed = routeEvents(events, privacy);
    expect(routed.public).toEqual([]);
    expect(routeContract.post(routed, events, privacy)).toBe(true);
  });
});
