type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? order.info;

function log(level: Level, msg: string, extra?: unknown) {
  if (order[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra instanceof Error ? (extra.stack ?? extra.message) : extra);
}

export const logger = {
  debug: (msg: string, extra?: unknown) => log('debug', msg, extra),
  info: (msg: string, extra?: unknown) => log('info', msg, extra),
  warn: (msg: string, extra?: unknown) => log('warn', msg, extra),
  error: (msg: string, extra?: unknown) => log('error', msg, extra),
};
