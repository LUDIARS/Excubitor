import { describe, expect, it } from 'vitest';
import { isContainerPortForwarder } from './container-forwarder.js';

describe('isContainerPortForwarder', () => {
  it('recognizes container runtime port forwarders', () => {
    for (const p of [
      { name: 'OrbStack', commandLine: '/Applications/OrbStack.app/Contents/MacOS/OrbStack' },
      { name: 'com.docker.backend.exe' },
      { name: 'vpnkit.exe', commandLine: 'C:\\Program Files\\Docker\\Docker\\resources\\vpnkit.exe' },
      { name: 'docker-proxy', commandLine: '/usr/bin/docker-proxy -proto tcp -host-port 8080' },
      { name: 'wslrelay.exe' },
      { commandLine: '/opt/homebrew/bin/limactl hostagent colima' },
    ]) expect(isContainerPortForwarder(p)).toBe(true);
  });

  it('does not flag ordinary service processes', () => {
    for (const p of [
      { name: 'node', commandLine: 'node --run dev' },
      { name: 'node.exe', commandLine: 'node E:/Document/Ars/Concordia/dist/index.js --docker-host x' },
      null,
      {},
    ]) expect(isContainerPortForwarder(p)).toBe(false);
  });
});
