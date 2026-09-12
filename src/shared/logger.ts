import pino, { type Logger } from 'pino';

export interface LoggerOptions {
  level: string;
  /** Human-readable output for local development; JSON otherwise. */
  pretty: boolean;
}

export function createLogger({ level, pretty }: LoggerOptions): Logger {
  return pino({
    level,
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }
      : {}),
  });
}

export type { Logger };
