import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { BotContext } from './context.js';
import { syncCard } from './discord/sync.js';
import { logger } from './logger.js';

/**
 * Webhook da Goalfy → bot (opcional; ligado quando WEBHOOK_PUBLIC_URL está definido).
 *
 * A Goalfy permite assinar eventos de um board (POST /external/v1/boards/{id}/hook).
 * A cada MOVE_CARD_TO ela faz um POST com um JSON do card (`id`, `boardId`, `currentPhase`, campos…).
 *
 * O payload não é assinado, então:
 *  - a URL carrega um segredo (`/goalfy/webhook/<segredo>`);
 *  - o payload é tratado só como um "aviso": o bot relê o card na API antes de agir.
 *
 * O polling continua ativo (comentários não geram evento e ele cobre webhooks perdidos).
 */

/** O hook é guardado por ambiente (API + board): trocar de ambiente não reaproveita o hook de outro. */
const hookKey = (ctx: BotContext) => `goalfy.hook.MOVE_CARD_TO:${ctx.config.GOALFY_API_URL}:${ctx.board.boardId}`;
const LEGACY_HOOK_KEY = 'goalfy.hook.MOVE_CARD_TO';
const isLocalHost =(url: string) => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url);
const SECRET_KEY = 'goalfy.webhook.secret';
const MAX_BODY = 1024 * 1024;

function secretFor(ctx: BotContext): string {
  if (ctx.config.WEBHOOK_SECRET) return ctx.config.WEBHOOK_SECRET;
  let secret = ctx.store.get(SECRET_KEY);
  if (!secret) {
    secret = randomBytes(24).toString('base64url');
    ctx.store.set(SECRET_KEY, secret);
  }
  return secret;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Registra (ou reaproveita) a assinatura do evento de mudança de fase no board. */
async function ensureHook(ctx: BotContext, hookUrl: string) {
  // Bancos antigos guardavam o hook numa chave única, sem ambiente: reaproveita para não duplicar o hook.
  const stored = ctx.store.get(hookKey(ctx)) ?? ctx.store.get(LEGACY_HOOK_KEY);
  const previous = stored ? (JSON.parse(stored) as { id: string; url: string }) : undefined;
  if (previous?.url === hookUrl) {
    ctx.store.set(hookKey(ctx), stored!);
    logger.info(`Webhook da Goalfy já registrado (hook ${previous.id})`);
    return;
  }
  if (previous) {
    await ctx.goalfy.deleteBoardHook(ctx.board.boardId, previous.id).catch((e) => logger.warn('Não consegui remover o webhook antigo', e));
  }

  const raw = (await ctx.goalfy.subscribeBoardHook(ctx.board.boardId, 'MOVE_CARD_TO', hookUrl)) as Record<string, unknown>;
  const inner = (raw?.hook ?? raw) as Record<string, unknown>;
  const id = inner?.id !== undefined ? String(inner.id) : undefined;
  if (!id) throw new Error('A Goalfy não retornou o ID do webhook criado.');
  ctx.store.set(hookKey(ctx), JSON.stringify({ id, url: hookUrl }));
  logger.info(`Webhook da Goalfy registrado (hook ${id}) → ${hookUrl.replace(/[^/]+$/, '***')}`);
}

export async function startWebhookServer(ctx: BotContext): Promise<Server | undefined> {
  const base = ctx.config.WEBHOOK_PUBLIC_URL;
  if (!base) return undefined;
  if (isLocalHost(base) && !isLocalHost(ctx.config.GOALFY_API_URL)) {
    // A Goalfy remota (dev/prod) não alcança o localhost desta máquina: o hook nunca seria entregue.
    logger.warn(`WEBHOOK_PUBLIC_URL (${base}) é local, mas a Goalfy (${ctx.config.GOALFY_API_URL}) é remota; webhook desligado, seguindo só com polling.`);
    return undefined;
  }

  const secret = secretFor(ctx);
  const path = `/goalfy/webhook/${secret}`;

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (req.method !== 'POST' || !req.url || !safeEqual(req.url, path)) {
      res.writeHead(404).end();
      return;
    }

    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      // Responde logo: a Goalfy não precisa esperar o Discord.
      res.writeHead(204).end();
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        logger.warn('Webhook com JSON inválido ignorado');
        return;
      }
      const cardId = payload.id !== undefined ? String(payload.id) : undefined;
      if (!cardId || String(payload.boardId ?? '') !== ctx.board.boardId) return;
      if (!ctx.store.byCard(cardId)) {
        logger.debug(`Webhook recebido: card ${cardId} → "${String(payload.currentPhase ?? '?')}" (sem tópico vinculado, ignorado)`);
        return;
      }
      logger.debug(`Webhook: card ${cardId} mudou para "${String(payload.currentPhase ?? '?')}"`);
      syncCard(ctx, cardId, { comments: false }).catch((e) => logger.warn(`Falha ao processar webhook do card ${cardId}`, e));
    });
  });

  await new Promise<void>((resolve) => server.listen(ctx.config.WEBHOOK_PORT, resolve));
  logger.info(`Servidor de webhook ouvindo na porta ${ctx.config.WEBHOOK_PORT}`);

  try {
    await ensureHook(ctx, `${base.replace(/\/$/, '')}${path}`);
  } catch (e) {
    logger.error('Não consegui registrar o webhook na Goalfy; seguindo só com polling.', e);
  }
  return server;
}
