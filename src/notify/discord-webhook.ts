const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'canary.discord.com',
  'ptb.discord.com',
  'discordapp.com',
]);

export type FetchLike = typeof fetch;

export function normalizeDiscordWebhookUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'https:') throw new Error('Discord webhook must use HTTPS');
  if (!DISCORD_WEBHOOK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Discord webhook host is not allowed');
  }
  if (!/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname)) {
    throw new Error('Discord webhook path is invalid');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function sendDiscordWebhook(
  webhookUrl: string,
  content: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const url = normalizeDiscordWebhookUrl(webhookUrl);
  const message = content.trim().slice(0, 2000);
  if (!message) throw new Error('Discord notification content is empty');
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: message, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Discord webhook failed with HTTP ${response.status}`);
  }
}
