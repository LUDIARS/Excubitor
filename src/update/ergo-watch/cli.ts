/**
 * Ergo パッケージ更新の配送ジョブの入口 (Task Scheduler / cron から 15 分ごとに 1 回起動)。
 *
 * `--discord` で暗号化 config の webhook へ配送する。 無ければ本文を表示するだけで状態を書かない。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { resolve } from 'node:path';

import { loadCatalog } from '../../catalog/loader.js';
import { DEFAULT_RUNTIME_CONFIG_PATH } from '../../catalog/runtime-config.js';
import { getErgoWatchDiscordConfig } from '../../secrets/config-store.js';
import { loadErgoWatchConfig } from './config.js';
import { runErgoWatchJob } from './job.js';

interface CliOptions {
  configPath: string;
  stateDir: string;
  discord: boolean;
  json: boolean;
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const catalog = loadCatalog(options.configPath);
  const config = loadErgoWatchConfig(options.configPath);
  const result = await runErgoWatchJob({
    catalog,
    config,
    stateDir: options.stateDir,
    now: new Date(),
    webhooks: options.discord ? requireWebhooks() : null,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      hosts: result.hosts,
      events: result.events,
      messages: result.messages.length,
      sent: result.delivery?.sent ?? 0,
      withheld: result.delivery?.withheld ?? 0,
      unsent: result.delivery?.unsent.length ?? 0,
      issues: result.issues,
      error: result.error,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.text}\n`);
  }
  for (const issue of result.issues) process.stderr.write(`ergo watch: ${issue.service}: ${issue.message}\n`);
  if (result.error) process.stderr.write(`ergo watch: ${result.error}\n`);
  if (!result.ok) process.exitCode = 1;
}

function requireWebhooks(): { public: string; private: string } {
  const config = getErgoWatchDiscordConfig();
  if (!config?.enabled || !config.webhookUrl) {
    throw new Error('Ergo watch Discord webhook is not configured or enabled');
  }
  return { public: config.webhookUrl, private: config.privateWebhookUrl };
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    configPath: DEFAULT_RUNTIME_CONFIG_PATH,
    stateDir: resolve(process.cwd(), 'data', 'ergo-watch'),
    discord: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--discord') options.discord = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--config') options.configPath = requiredValue(argv, ++index, argument);
    else if (argument === '--state') options.stateDir = resolve(requiredValue(argv, ++index, argument));
    else throw new Error(`unknown argument: ${String(argument)}`);
  }
  return options;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ergo watch failed: ${message}\n`);
  process.exitCode = 1;
});
