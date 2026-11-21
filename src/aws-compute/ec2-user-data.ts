import type { LaunchIntent } from './job-types.js';
import type { Ec2Target } from './target-schema.js';

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

/** Install the shutdown before invoking the registered Linux runner, using the absolute deadline. */
export function ec2UserData(runner: Ec2Target['runners'][number], intent: LaunchIntent): string {
  const seconds = Math.floor(intent.deadline / 1000);
  const env = Object.entries(intent.inputs).map(([key, input]) => quote(`${key}=${input}`));
  const command = [runner.executable, ...runner.args].map(quote);
  const script = [
    '#!/bin/sh',
    'set -eu',
    `remaining=$((${seconds} - $(date +%s)))`,
    'if [ "$remaining" -lt 60 ]; then',
    '  exec shutdown -h now',
    'fi',
    'shutdown -h "+$((remaining / 60))"',
    // Running the command as a child ensures successful and failed runs both initiate shutdown.
    'trap \'shutdown -h now\' EXIT',
    ['env', '--', ...env, ...command].join(' '),
  ].join('\n') + '\n';
  if (Buffer.byteLength(script) > 16_384) throw new Error('ec2_user_data_too_large');
  return Buffer.from(script).toString('base64');
}
