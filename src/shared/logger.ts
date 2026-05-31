import pino from 'pino';

const level = process.env.EXCUBITOR_LOG_LEVEL ?? 'info';
export const rootLogger = pino({ level });

export function createNamedLogger(name: string) {
  return rootLogger.child({ name });
}

