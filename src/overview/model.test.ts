import { describe, it, expect } from 'vitest';
import { groupOverviewServices, type OverviewComponent } from './model.js';
const row = (code: string, state: 'up' | 'down', extras: Partial<OverviewComponent> = {}) => ({
  project: 'project', code, name: code, state, observed: true, checked_at: 1,
  version: '1.0', startup: false, subdomain: null, frontend_url: null, disabled: false, ...extras,
});
describe('logical service availability', () => {
  it('groups siblings and keeps version divergence visible', () => {
    const result = groupOverviewServices([row('api','up'),row('worker','down',{version:'2.0',startup:true})]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({state:'partial',startup:true,versions:['1.0','2.0']});
  });
  it('requires every enabled component to be observed and up', () => {
    expect(groupOverviewServices([row('api','up'),row('worker','up',{observed:false})])[0]?.state).toBe('partial');
    expect(groupOverviewServices([row('api','down',{observed:false})])[0]).toMatchObject({state:'down',observed:false});
    expect(groupOverviewServices([row('api','up')])[0]?.state).toBe('up');
  });
  it('excludes disabled components and never treats an empty active set as up', () => {
    expect(groupOverviewServices([row('api','up'),row('disabled','down',{disabled:true})])[0]?.state).toBe('up');
    expect(groupOverviewServices([row('disabled','up',{disabled:true})])[0]?.state).toBe('down');
  });
  it('does not merge distinct project codes', () => {
    expect(groupOverviewServices([row('a','up'),{...row('b','up'),project:'other'}])).toHaveLength(2);
  });
});
