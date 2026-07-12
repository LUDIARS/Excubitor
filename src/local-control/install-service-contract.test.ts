import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('local-control installation contracts', () => {
  it('keeps managed children alive across a systemd supervisor crash restart', async () => {
    const script = await readFile(new URL('../../scripts/install-service.sh', import.meta.url), 'utf8');
    expect(script).toContain('KillMode=process');
    expect(script).toContain('<key>AbandonProcessGroup</key><true/>');
    expect(script).toContain("NODE=\"$(node -p 'process.execPath')\"");
    expect(script).toContain('<string>${NODE_XML}</string>');
    expect(script).toContain('<string>${RUNNER_XML}</string>');
    expect(script).toContain('<string>${SERVICE_NAME_ARG_XML}</string>');
    expect(script).toContain('ExecStart="${NODE_SYSTEMD}" "${RUNNER_SYSTEMD}" --service-name=${NAME}');
    expect(script).not.toContain('run service');
    expect(script).toContain('^[A-Za-z0-9_.-]+$');
    expect(script).toContain('systemctl --user enable --now');
  });

  it('registers the Windows task with Node as the owned main process', async () => {
    const script = await readFile(new URL('../../scripts/install-service.ps1', import.meta.url), 'utf8');
    expect(script).toContain("Get-Command node.exe -CommandType Application");
    expect(script).toContain("Join-Path $Root 'dist\\service-runner.js'");
    expect(script).toContain('"`"$ServiceRunner`" --service-name=$Name"');
    expect(script).toContain('-Execute $NodeExecutable -Argument $ActionArguments -WorkingDirectory $Root');
    expect(script).not.toContain('New-ScheduledTaskAction -Execute "powershell.exe"');
    expect(script).toContain('$Arguments.IndexOf($RunScript');
    expect(script).toContain('$Arguments.IndexOf($ServiceRunner');
  });

  it('preserves Windows task migration rollback and legacy-wrapper ownership', async () => {
    const [installScript, uninstallScript] = await Promise.all([
      readFile(new URL('../../scripts/install-service.ps1', import.meta.url), 'utf8'),
      readFile(new URL('../../scripts/uninstall-service.ps1', import.meta.url), 'utf8'),
    ]);
    expect(installScript).toContain('Export-ScheduledTask -TaskName $Name');
    expect(installScript).toContain('-Xml $PreviousTaskXml -Force');
    expect(installScript).toContain('Restore-LegacyService $LegacyBackup');
    for (const script of [installScript, uninstallScript]) {
      expect(script).toContain('$Arguments.IndexOf($ServiceRunner');
      expect(script).toContain('$Arguments.IndexOf($RunScript');
    }
  });

  it('builds the WebUI before the Windows launcher requests backend start', async () => {
    const script = await readFile(new URL('../../start-excubitor.bat', import.meta.url), 'utf8');
    const frontendBuild = script.indexOf('npm --prefix frontend run build');
    const backendStart = script.indexOf('npm run ctl -- excubitor start --json');
    expect(frontendBuild).toBeGreaterThan(-1);
    expect(backendStart).toBeGreaterThan(frontendBuild);
  });
});
