import { describe, expect, it } from 'vitest';
import { readinessDecision } from './backend-readiness-decision.js';
import decisionContract from './backend-readiness-decision.contract.js';

const TIMEOUT = 90_000;

describe('readinessDecision', () => {
  it('keeps waiting until the first timeout boundary', () => {
    expect(readinessDecision({ elapsedMs: 0, timeoutMs: TIMEOUT, processAlive: true, extended: false })).toBe('wait');
    expect(readinessDecision({ elapsedMs: TIMEOUT - 1, timeoutMs: TIMEOUT, processAlive: true, extended: false }))
      .toBe('wait');
  });

  it('extends exactly at the timeout while the process is alive', () => {
    expect(readinessDecision({ elapsedMs: TIMEOUT, timeoutMs: TIMEOUT, processAlive: true, extended: false }))
      .toBe('extend');
    expect(readinessDecision({ elapsedMs: TIMEOUT * 5, timeoutMs: TIMEOUT, processAlive: true, extended: false }))
      .toBe('extend');
  });

  it('waits through the extension of the same length', () => {
    expect(readinessDecision({ elapsedMs: TIMEOUT, timeoutMs: TIMEOUT, processAlive: true, extended: true }))
      .toBe('wait');
    expect(readinessDecision({ elapsedMs: TIMEOUT * 2 - 1, timeoutMs: TIMEOUT, processAlive: true, extended: true }))
      .toBe('wait');
  });

  it('gives up at twice the timeout after one extension', () => {
    expect(readinessDecision({ elapsedMs: TIMEOUT * 2, timeoutMs: TIMEOUT, processAlive: true, extended: true }))
      .toBe('timeout');
  });

  it('never extends an exited process', () => {
    expect(readinessDecision({ elapsedMs: 0, timeoutMs: TIMEOUT, processAlive: false, extended: false }))
      .toBe('exited');
    expect(readinessDecision({ elapsedMs: TIMEOUT, timeoutMs: TIMEOUT, processAlive: false, extended: false }))
      .toBe('exited');
    expect(readinessDecision({ elapsedMs: TIMEOUT * 2, timeoutMs: TIMEOUT, processAlive: false, extended: true }))
      .toBe('exited');
  });
});

describe('C-9 readinessDecision contract', () => {
  it('accepts well-formed input and every decision', () => {
    expect(decisionContract.pre({ elapsedMs: 0, timeoutMs: TIMEOUT, processAlive: true, extended: false })).toBe(true);
    for (const decision of ['wait', 'extend', 'exited', 'timeout']) {
      expect(decisionContract.post(decision)).toBe(true);
    }
  });

  it('rejects malformed input and unknown decisions', () => {
    expect(decisionContract.pre({ elapsedMs: -1, timeoutMs: TIMEOUT, processAlive: true, extended: false }))
      .toEqual(expect.any(String));
    expect(decisionContract.pre({ elapsedMs: 0, timeoutMs: 0, processAlive: true, extended: false }))
      .toEqual(expect.any(String));
    expect(decisionContract.pre({ elapsedMs: 0, timeoutMs: TIMEOUT, processAlive: 'yes', extended: false }))
      .toEqual(expect.any(String));
    expect(decisionContract.post('retry')).toEqual(expect.any(String));
  });

  it('holds for the decisions the implementation returns', () => {
    for (const processAlive of [true, false]) {
      for (const extended of [true, false]) {
        for (const elapsedMs of [0, TIMEOUT - 1, TIMEOUT, TIMEOUT * 2 - 1, TIMEOUT * 2]) {
          const input = { elapsedMs, timeoutMs: TIMEOUT, processAlive, extended };
          expect(decisionContract.pre(input)).toBe(true);
          expect(decisionContract.post(readinessDecision(input))).toBe(true);
        }
      }
    }
  });
});
