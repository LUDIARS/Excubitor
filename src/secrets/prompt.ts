/**
 * 対話プロンプト (init-infisical CLI 用)。
 *
 * env-cli (Cernere/packages/env-cli) の setup と同じ操作感:
 *   - ask(question, default?) : 1 行入力 (空 Enter で default)
 *   - askSecret(question)     : 入力をマスク (`*`) する秘匿入力
 *
 * 依存を増やさないため node:readline を直接使う。 askSecret は raw mode で
 * 1 文字ずつ拾い、 端末に実値を出さない (backspace / Ctrl-C 対応)。
 */

import { createInterface, type Interface } from 'node:readline';
import { stdin, stdout } from 'node:process';

const CTRL_C = 0x03;
const BACKSPACE = 0x08;
const DEL = 0x7f;
const CR = 0x0d;
const LF = 0x0a;

export interface Prompt {
  ask(question: string, defaultValue?: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  close(): void;
}

export function createPrompt(): Prompt {
  let rl: Interface | null = null;
  const ensureRl = (): Interface => {
    rl ??= createInterface({ input: stdin, output: stdout });
    return rl;
  };

  const ask = (question: string, defaultValue?: string): Promise<string> => {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    return new Promise((resolve) => {
      ensureRl().question(`${question}${suffix}: `, (answer) => {
        const trimmed = answer.trim();
        resolve(trimmed.length > 0 ? trimmed : (defaultValue ?? ''));
      });
    });
  };

  const askSecret = (question: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      // readline と raw mode は競合するので、 秘匿入力中は readline を一旦閉じる。
      if (rl) {
        rl.close();
        rl = null;
      }
      stdout.write(`${question}: `);
      const wasRaw = stdin.isRaw ?? false;
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();

      let value = '';
      const cleanup = (): void => {
        stdin.off('data', onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        stdin.pause();
      };
      const onData = (chunk: Buffer): void => {
        for (const byte of chunk) {
          if (byte === CR || byte === LF) {
            cleanup();
            stdout.write('\n');
            resolve(value);
            return;
          }
          if (byte === CTRL_C) {
            cleanup();
            stdout.write('\n');
            reject(new Error('aborted'));
            return;
          }
          if (byte === BACKSPACE || byte === DEL) {
            if (value.length > 0) {
              value = value.slice(0, -1);
              stdout.write('\b \b');
            }
            continue;
          }
          // 印字可能 ASCII のみ採用 (制御文字は無視)。
          if (byte >= 0x20 && byte < 0x7f) {
            value += String.fromCharCode(byte);
            stdout.write('*');
          }
        }
      };
      stdin.on('data', onData);
    });
  };

  const close = (): void => {
    if (rl) {
      rl.close();
      rl = null;
    }
  };

  return { ask, askSecret, close };
}
