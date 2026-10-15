/**
 * メッセージ列を配送先の webhook へ順に送る。
 *
 * - 非公開のメッセージは非公開用 webhook にだけ送る。 未設定なら送らずに数える (公開へ回さない)
 * - 送信に失敗したら、 そのメッセージ以降を順序を保って返す (呼び出し側が再送用に残す)
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { sendDiscordWebhook } from '../../notify/discord-webhook.js';
import type { DeliveryChannel, DeliveryMessage } from './types.js';

export type WebhookSender = (webhookUrl: string, content: string) => Promise<void>;

export interface DeliveryResult {
  sent: number;
  /** 非公開用 webhook が未設定で送らなかった数。 */
  withheld: number;
  /** 送れず次の回へ持ち越すもの。 */
  unsent: DeliveryMessage[];
  error: string | null;
}

export async function deliverMessages(
  messages: DeliveryMessage[],
  webhooks: Record<DeliveryChannel, string>,
  send: WebhookSender = sendDiscordWebhook,
): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, withheld: 0, unsent: [], error: null };
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const url = webhooks[message.channel];
    if (!url) {
      result.withheld += 1;
      continue;
    }
    try {
      await send(url, message.content);
      result.sent += 1;
    } catch (err) {
      // webhook の URL は例外文に含まれない (sendDiscordWebhook は HTTP status だけを返す)。
      result.error = err instanceof Error ? err.message : String(err);
      result.unsent = messages.slice(index).filter((entry) => webhooks[entry.channel]);
      break;
    }
  }
  return result;
}
