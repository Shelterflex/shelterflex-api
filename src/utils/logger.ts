import { redactPiiFields } from './piiRedaction.js'

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
     debug: 0,
     info: 1,
     warn: 2,
     error: 3
}

function getConfigLevel(): LogLevel {
     const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
     if (raw in LEVELS) return raw as LogLevel;
     process.stderr.write(
          JSON.stringify({ level: 'warn', message: `Invalid LOG_LEVEL "${raw}", defaulting to "info"` }) + '\n',
     );
     return 'info';
}

const configLevel = getConfigLevel();

function shouldLog(level: LogLevel): boolean {
     return LEVELS[level] >= LEVELS[configLevel];
}

type LogFields = Record<string, unknown>;

function write(level: LogLevel, message: string, fields?: LogFields): void {
     if (!shouldLog(level)) return;

     const entry: Record<string, unknown> = {
          timestamp: new Date().toISOString(),
          level,
          message,
          ...(fields ? (redactPiiFields(fields) as LogFields) : {}),
     };

     process.stdout.write(JSON.stringify(entry) + '\n');
}

export const logger = {
     debug: (message: string, fields?: LogFields) => write('debug', message, fields),
     info: (message: string, fields?: LogFields) => write('info', message, fields),
     warn: (message: string, fields?: LogFields) => write('warn', message, fields),
     error: (message: string, fields?: LogFields, err?: unknown) => {
          const errorFields: LogFields = {};
          if (err instanceof Error) {
               errorFields.errorMessage = err.message;

               if (process.env.LOG_STACK_TRACES === 'true') {
                    errorFields.stack = err.stack;
               }
          }
          write('error', message, { ...fields, ...errorFields });
     },
};

const lastLoggedAt = new Map<string, number>();

/**
 * Logs at most once per `windowMs` for a given `key`. Meant for errors that
 * can fire on every request during a sustained outage (e.g. a downstream
 * dependency being unreachable) where per-request logging would flood output.
 */
export function logThrottled(
     level: 'warn' | 'error',
     key: string,
     windowMs: number,
     message: string,
     fields?: LogFields,
): void {
     const now = Date.now();
     const last = lastLoggedAt.get(key) ?? 0;
     if (now - last < windowMs) return;
     lastLoggedAt.set(key, now);
     write(level, message, fields);
}
