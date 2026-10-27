import { describe, it, expect, vi } from 'vitest';
import { RequestFilter, type RequestFilterDeps } from './request-filter.js';
import { config, event } from './test-fixtures.js';

function harness(overrides: Partial<RequestFilterDeps> = {}) {
  const deps: RequestFilterDeps = { evidence: vi.fn(), notifyDenied: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn(), now: () => 1000, ...overrides };
  return { filter: new RequestFilter(config, deps), deps };
}
describe('request filtering preserves JP availability', () => {
  it.each(['US', 'XX', '', 'T1'])('denies and logs %s without latching subsequent JP requests', async country => {
    const {filter, deps} = harness();
    expect(filter.inspect({...event, country})).toBe(false);
    expect(deps.evidence).toHaveBeenCalledWith(expect.objectContaining({country}), 403);
    expect(filter.inspect(event)).toBe(true);
    filter.response(event, 200);
    expect(deps.evidence).toHaveBeenCalledWith(event, 200);
    expect(filter.status()).toMatchObject({state:'armed',incident:null});
    await filter.stop();
  });
  it('rejects an exploit request without denying another normal JP request', async () => {
    const {filter} = harness();
    expect(filter.inspect({...event,path:'/.env'})).toBe(false);
    expect(filter.inspect(event)).toBe(true);
    await filter.stop();
  });
  it('records every denial while bounding Discord work', async () => {
    const {filter,deps} = harness();
    for(let i=0;i<30;i++) filter.inspect({...event,country:'US'});
    await filter.stop();
    expect(deps.evidence).toHaveBeenCalledTimes(30);
    expect(deps.notifyDenied).toHaveBeenCalledTimes(1);
  });
  it('exposes log failure without silently claiming logs or closing the site', async () => {
    const {filter,deps} = harness({evidence:()=>{throw new Error('disk full');}});
    filter.response(event,200);
    expect(filter.status().logging).toBe('failed');
    expect(deps.warn).toHaveBeenCalled();
    expect(filter.inspect(event)).toBe(true);
    await filter.stop();
  });
  it('survives notification failure and stops accepting requests during shutdown', async () => {
    const {filter,deps} = harness({notifyDenied:vi.fn().mockRejectedValue(new Error('offline'))});
    filter.inspect({...event,country:'US'});
    await filter.stop();
    expect(deps.warn).toHaveBeenCalled();
    expect(filter.inspect(event)).toBe(false);
  });
});
