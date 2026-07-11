import { describe, expect, it, vi } from 'vitest';
import { normalizeDiscordWebhookUrl, sendDiscordWebhook } from './discord-webhook.js';

describe('Discord webhook', () => {
  it('accepts only Discord HTTPS webhook URLs', () => {
    expect(normalizeDiscordWebhookUrl('https://discord.com/api/webhooks/123/token_abc'))
      .toBe('https://discord.com/api/webhooks/123/token_abc');
    expect(() => normalizeDiscordWebhookUrl('http://discord.com/api/webhooks/123/token'))
      .toThrow('HTTPS');
    expect(() => normalizeDiscordWebhookUrl('https://example.com/api/webhooks/123/token'))
      .toThrow('host');
  });

  it('posts a mention-safe Discord payload', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    await sendDiscordWebhook(
      'https://discord.com/api/webhooks/123/token',
      '@everyone service down',
      fetchMock as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toEqual({
      content: '@everyone service down',
      allowed_mentions: { parse: [] },
    });
  });

  it('reports non-success responses without leaking the webhook URL', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 429 }));
    await expect(sendDiscordWebhook(
      'https://discord.com/api/webhooks/123/sensitive-token',
      'test',
      fetchMock as typeof fetch,
    )).rejects.toThrow('HTTP 429');
    await expect(sendDiscordWebhook(
      'https://discord.com/api/webhooks/123/sensitive-token',
      'test',
      fetchMock as typeof fetch,
    )).rejects.not.toThrow('sensitive-token');
  });
});
