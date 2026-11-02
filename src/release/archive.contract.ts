import { basename, dirname, resolve } from 'node:path';
import type { ArchiveCommand } from './archive.js';

export default {
  post(result: ArchiveCommand, bundleDir: string, zipPath: string, platform: string): boolean | string {
    if (result.options.shell !== false || result.options.cwd !== dirname(resolve(bundleDir))) return 'archive must use an explicit cwd without shell';
    if (platform !== 'win32') {
      return (result.cmd === 'zip' && JSON.stringify(result.args) === JSON.stringify(['-rq', resolve(zipPath), '--', basename(resolve(bundleDir))])) || 'zip must receive literal argv';
    }
    return (result.cmd === 'powershell' && result.options.env?.EXCUBITOR_ARCHIVE_SOURCE === resolve(bundleDir)
      && result.options.env?.EXCUBITOR_ARCHIVE_DESTINATION === resolve(zipPath)
      && result.args.join(' ').includes('-LiteralPath $env:EXCUBITOR_ARCHIVE_SOURCE')
      && result.args.join(' ').includes('-LiteralPath $paths')) || 'PowerShell must use environment paths and literal sources';
  },
};
