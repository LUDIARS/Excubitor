import { describe, expect, it } from 'vitest';

import { formatPackageAuditDiscordMessages } from './format.js';
import type { PackageAuditReport } from './types.js';

describe('package audit Discord report', () => {
  it('lists package, projects, versions and release notes within Discord limits', () => {
    const report: PackageAuditReport = {
      capturedAt: '2026-07-31T00:00:00.000Z',
      summary: {
        safe: 1,
        major: 0,
        native: 0,
        total: 1,
        localTargets: 2,
        globalPackages: 3,
        vulnerabilities: 0,
        issues: 0,
      },
      updates: [{
        scope: 'local',
        target: 'alpha, beta',
        projects: ['alpha', 'beta'],
        packageName: 'example',
        current: '1.0.0',
        wanted: '1.1.0',
        latest: '1.1.0',
        category: 'safe',
        semverImpact: 'safe',
        requiresRebuild: false,
        nativeReasons: [],
        dependencyType: 'dependencies',
        releaseNotes: 'Fixed startup behavior.',
        releaseUrl: 'https://github.com/example/example/releases/tag/v1.1.0',
      }],
      vulnerabilities: [],
      globalCli: [],
      issues: [],
    };

    const messages = formatPackageAuditDiscordMessages(report);
    expect(messages.every((message) => message.length <= 1_900)).toBe(true);
    expect(messages.join('\n')).toContain('alpha');
    expect(messages.join('\n')).toContain('1.0.0 → 1.1.0');
    expect(messages.join('\n')).toContain('Fixed startup behavior');
  });

  it('reports projects skipped by npm audit because they have no lockfile', () => {
    const report: PackageAuditReport = {
      capturedAt: '2026-07-31T00:00:00.000Z',
      summary: {
        safe: 0,
        major: 0,
        native: 0,
        total: 0,
        localTargets: 1,
        globalPackages: 0,
        vulnerabilities: 0,
        issues: 1,
      },
      updates: [],
      vulnerabilities: [],
      globalCli: [],
      issues: [{
        scope: 'local',
        target: 'unlocked-project',
        code: 'npm_audit_lock_missing',
        message: 'package-lock.json is missing; npm audit was not run',
      }],
    };

    const rendered = formatPackageAuditDiscordMessages(report).join('\n');
    expect(rendered).toContain('npm audit 未実施');
    expect(rendered).toContain('unlocked\\-project');
  });

  it('splits an oversized item without allowing webhook truncation to discard projects', () => {
    const projects = Array.from({ length: 350 }, (_, index) => `project-${String(index).padStart(3, '0')}`);
    const report: PackageAuditReport = {
      capturedAt: '2026-07-31T00:00:00.000Z',
      summary: {
        safe: 1,
        major: 0,
        native: 0,
        total: 1,
        localTargets: projects.length,
        globalPackages: 0,
        vulnerabilities: 0,
        issues: 0,
      },
      updates: [{
        scope: 'local',
        target: projects.join(', '),
        projects,
        packageName: 'example',
        current: '1.0.0',
        wanted: '1.1.0',
        latest: '1.1.0',
        category: 'safe',
        semverImpact: 'safe',
        requiresRebuild: false,
        nativeReasons: [],
        dependencyType: 'dependencies',
        releaseNotes: null,
        releaseUrl: null,
      }],
      vulnerabilities: [],
      globalCli: [],
      issues: [],
    };

    const messages = formatPackageAuditDiscordMessages(report);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 1_900)).toBe(true);
    for (const project of projects) expect(messages.join('\n')).toContain(project.replace('-', '\\-'));
  });
});
