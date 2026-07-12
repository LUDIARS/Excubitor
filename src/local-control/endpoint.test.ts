import { describe, expect, it } from 'vitest';
import { isWindowsNamedPipe, localControlEndpoint } from './endpoint.js';

describe('localControlEndpoint', () => {
  it('scopes Windows pipes to the account and service instance', () => {
    const first = localControlEndpoint({
      USERDOMAIN: 'WORKSTATION',
      USERNAME: 'operator',
      EXCUBITOR_SERVICE_NAME: 'Excubitor',
    }, 'win32');
    const same = localControlEndpoint({
      USERDOMAIN: 'workstation',
      USERNAME: 'OPERATOR',
      EXCUBITOR_SERVICE_NAME: 'excubitor',
    }, 'win32');
    const otherUser = localControlEndpoint({
      USERDOMAIN: 'WORKSTATION',
      USERNAME: 'someone-else',
      EXCUBITOR_SERVICE_NAME: 'Excubitor',
    }, 'win32');
    const otherInstance = localControlEndpoint({
      USERDOMAIN: 'WORKSTATION',
      USERNAME: 'operator',
      EXCUBITOR_SERVICE_NAME: 'Excubitor-Dev',
    }, 'win32');

    expect(isWindowsNamedPipe(first)).toBe(true);
    expect(same).toBe(first);
    expect(otherUser).not.toBe(first);
    expect(otherInstance).not.toBe(first);
  });

  it('honors an explicit endpoint on every platform', () => {
    expect(localControlEndpoint({ EXCUBITOR_CONTROL_ENDPOINT: 'test-endpoint' }, 'win32')).toBe('test-endpoint');
  });
});
