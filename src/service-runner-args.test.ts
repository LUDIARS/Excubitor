import { describe, expect, it } from 'vitest';
import { configureServiceRunnerEnvironment } from './service-runner-args.js';

describe('configureServiceRunnerEnvironment', () => {
  it('applies a validated service name and isolated port', () => {
    const env: NodeJS.ProcessEnv = {};

    configureServiceRunnerEnvironment(
      ['--port=58156', '--service-name=Excubitor-Smoke_1'],
      env,
    );

    expect(env.EXCUBITOR_SERVICE_NAME).toBe('Excubitor-Smoke_1');
    expect(env.EXCUBITOR_PORT).toBe('58156');
    expect(env.EXCUBITOR_SERVICE_MODE).toBe('1');
    expect(env.EXCUBITOR_SAFE_MODE).toBe('0');
  });

  it('normalizes a valid port and preserves a valid configured service name', () => {
    const env: NodeJS.ProcessEnv = { EXCUBITOR_SERVICE_NAME: ' Excubitor.Dev ' };

    configureServiceRunnerEnvironment(['--port=00001'], env);

    expect(env.EXCUBITOR_SERVICE_NAME).toBe('Excubitor.Dev');
    expect(env.EXCUBITOR_PORT).toBe('1');
    expect(env.EXCUBITOR_SERVICE_MODE).toBe('1');
    expect(env.EXCUBITOR_SAFE_MODE).toBe('0');
  });

  it.each([
    ['--service-name='],
    ['--service-name=bad name'],
    ['--service-name=bad\nname'],
    ['--port=0'],
    ['--port=65536'],
    ['--port=1.5'],
    ['--port=80', '--port=81'],
    ['--service-name=one', '--service-name=two'],
    ['--unknown=value'],
  ])('rejects invalid arguments without partially mutating env: %j', (...argv) => {
    const env: NodeJS.ProcessEnv = { EXCUBITOR_PORT: '17332' };

    expect(() => configureServiceRunnerEnvironment(argv, env)).toThrow();
    expect(env).toEqual({ EXCUBITOR_PORT: '17332' });
  });
});
