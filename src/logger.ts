type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? order.info;

export interface LogEntry {
  level: 'warn' | 'error';
  msg: string;
  /** Mensagem do erro anexo (sem stack), quando houver. */
  detail?: string;
  at: Date;
}

type Listener = (entry: LogEntry) => void;
const listeners = new Set<Listener>();

function log(level: Level, msg: string, extra?: unknown) {
  if (order[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra instanceof Error ? (extra.stack ?? extra.message) : extra);

  if (level === 'warn' || level === 'error') {
    const detail = extra instanceof Error ? extra.message : typeof extra === 'string' ? extra : undefined;
    for (const listener of listeners) {
      try {
        listener({ level, msg, detail, at: new Date() });
      } catch {
        // Um ouvinte com problema (ex.: alertas no Discord) nunca pode derrubar o log.
      }
    }
  }
}

export const logger = {
  debug: (msg: string, extra?: unknown) => log('debug', msg, extra),
  info: (msg: string, extra?: unknown) => log('info', msg, extra),
  warn: (msg: string, extra?: unknown) => log('warn', msg, extra),
  error: (msg: string, extra?: unknown) => log('error', msg, extra),
  /** Recebe cada WARN/ERROR (usado para os alertas no Discord). Retorna função para parar. */
  onWarnOrError(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
