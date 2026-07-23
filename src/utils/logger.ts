import { env } from '../config/env.js';

type LogOptions = {
  tags?: string[];
  meta?: Record<string, unknown>;
};

type LogContext = {
  timestamp: string;
  level: string;
  tags?: string[];
  message: string;
  meta?: Record<string, unknown>;
};

const isProduction = env.NODE_ENV === 'production';

const buildContext = (level: string, message: string, options: LogOptions = {}): LogContext => {
  const context: LogContext = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  if (options.tags?.length) context.tags = options.tags;
  if (options.meta) context.meta = options.meta;
  return context;
};

const format = (context: LogContext): string => {
  if (isProduction) return JSON.stringify(context);

  const parts: string[] = [context.timestamp, `[${context.level}]`];
  if (context.tags?.length) parts.push(`[${context.tags.join(',')}]`);
  parts.push(context.message);
  if (context.meta) parts.push(JSON.stringify(context.meta));
  return parts.join(' ');
};

export const Log = {
  debug(message: string, options?: LogOptions) {
    if (isProduction) return;
    console.debug(format(buildContext('DEBUG', message, options)));
  },
  info(message: string, options?: LogOptions) {
    console.info(format(buildContext('INFO', message, options)));
  },
  warn(message: string, options?: LogOptions) {
    console.warn(format(buildContext('WARN', message, options)));
  },
  error(message: string, options?: LogOptions) {
    console.error(format(buildContext('ERROR', message, options)));
  },
};
