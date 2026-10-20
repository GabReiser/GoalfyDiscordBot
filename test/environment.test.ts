/**
 * Troca de ambiente da Goalfy (local → dev → prod) sem perder o controle:
 * cards inacessíveis, hook guardado por ambiente e webhook localhost numa Goalfy remota.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BotContext } from '../src/context.js';
import { reconnectLink, resetUnreachable, syncCard } from '../src/discord/sync.js';
import { BoardService } from '../src/goalfy/board.js';
import { CardService } from '../src/goalfy/cards.js';
import { type GoalfyClient, GoalfyError } from '../src/goalfy/client.js';
import { Store } from '../src/store.js';
import { startWebhookServer } from '../src/webhook.js';

function setup(opts: { status?: number; config?: Record<string, unknown> } = {}) {
  const calls: string[] = [];
  const client = {
    listPhases: async () => [{ id: 'p1', title: 'Backlog', index: 0 }],
    getCard: async (id: string) => {
      if (opts.status) throw new GoalfyError(opts.status, 'Card não encontrado ou você não possui acesso.', `GET /cards/${id} → ${opts.status}`);
      return { id, title: 'X', phase: { id: 'p1' } };
    },
    listComments: async () => ({ comments: [] }),
    subscribeBoardHook: async (_b: string, _e: string, url: string) => {
      calls.push(`subscribe ${url}`);
      return { id: 'NEW' };
    },
    deleteBoardHook: async (_b: string, id: string) => calls.push(`delete ${id}`),
  } as unknown as GoalfyClient;
  const sent: string[] = [];
  const thread = { isThread: () => true, send: async (m: string) => sent.push(m) };
  const board = new BoardService(client, { GOALFY_BOARD_ID: 'B1', GOALFY_APP_URL: 'https://app', GOALFY_DONE_PHASES: [] } as never);
  const store = new Store(':memory:');
  store.link({ threadId: 't1', cardId: 'c1', channelId: 'f', createdBy: 'u1', phaseId: 'p1', phaseName: 'Backlog' });
  const ctx = {
    client: { channels: { fetch: async () => thread } },
    config: { SYNC_COMMENTS: false, GOALFY_API_URL: 'https://api.goalfy.com.br/api', WEBHOOK_PORT: 38000 + Math.floor(Math.random() * 1000), ...opts.config },
    goalfy: client,
    board,
    cards: new CardService(client, board),
    store,
  } as unknown as BotContext;
  return { ctx, store, sent, calls };
}

describe('card inacessível no ambiente atual', () => {
  it('403 passageiro (dono do token saiu e voltou ao board): não desconecta o tópico', async () => {
    resetUnreachable();
    const { ctx, store, sent } = setup({ status: 403 });
    for (let i = 0; i < 10; i++) await syncCard(ctx, 'c1');
    assert.equal(store.byCard('c1')?.closed, false, '10 falhas em poucos minutos: segue tentando');
    assert.equal(sent.length, 0);
  });

  it('403 por mais de 6h: encerra e avisa no tópico', async () => {
    resetUnreachable();
    const { ctx, store, sent } = setup({ status: 403 });
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await syncCard(ctx, 'c1');
      await syncCard(ctx, 'c1');
      now += 6 * 60 * 60_000 + 1;
      await syncCard(ctx, 'c1');
    } finally {
      Date.now = realNow;
    }
    assert.equal(store.byCard('c1')?.closed, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /Não consigo mais acessar o card/);
  });

  it('404: encerra na hora', async () => {
    const { ctx, store } = setup({ status: 404 });
    await syncCard(ctx, 'c1');
    assert.equal(store.byCard('c1')?.closed, true);
  });
});

describe('reconectar tópico desconectado', () => {
  it('card acessível de novo e em andamento: volta a ser acompanhado', async () => {
    const { ctx, store } = setup();
    store.updatePhase('c1', 'p1', 'Backlog', true);
    assert.equal(await reconnectLink(ctx, 'c1'), 'reopened');
    assert.equal(store.byCard('c1')?.closed, false);
  });

  it('vínculo que não estava encerrado: nada a fazer', async () => {
    const { ctx } = setup();
    assert.equal(await reconnectLink(ctx, 'c1'), 'open');
  });

  it('card ainda inacessível: avisa com erro e continua encerrado', async () => {
    const { ctx, store } = setup({ status: 403 });
    store.updatePhase('c1', 'p1', 'Backlog', true);
    await assert.rejects(reconnectLink(ctx, 'c1'));
    assert.equal(store.byCard('c1')?.closed, true);
  });
});

describe('webhook por ambiente', () => {
  it('não registra webhook localhost numa Goalfy remota', async () => {
    const { ctx, calls } = setup({ config: { WEBHOOK_PUBLIC_URL: 'http://localhost:3001', GOALFY_API_URL: 'https://api-dev.goalfy.com.br/api' } });
    assert.equal(await startWebhookServer(ctx), undefined);
    assert.deepEqual(calls, []);
  });

  it('reaproveita o hook salvo no formato antigo (sem duplicar em produção)', async () => {
    const { ctx, store, calls } = setup({ config: { WEBHOOK_PUBLIC_URL: 'https://bot.exemplo.com', WEBHOOK_SECRET: 's' } });
    store.set('goalfy.hook.MOVE_CARD_TO', JSON.stringify({ id: 'OLD', url: 'https://bot.exemplo.com/goalfy/webhook/s' }));
    const server = await startWebhookServer(ctx);
    server?.close();
    assert.deepEqual(calls, [], 'nem cria nem remove hook');
    assert.match(store.get('goalfy.hook.MOVE_CARD_TO:https://api.goalfy.com.br/api:B1') ?? '', /"OLD"/, 'migrado para a chave por ambiente');
  });

  it('outro ambiente não reaproveita o hook do anterior', async () => {
    const { ctx, store, calls } = setup({ config: { WEBHOOK_PUBLIC_URL: 'https://bot.exemplo.com', WEBHOOK_SECRET: 's', GOALFY_API_URL: 'https://api-dev.goalfy.com.br/api' } });
    store.set('goalfy.hook.MOVE_CARD_TO:https://api.goalfy.com.br/api:B1', JSON.stringify({ id: 'PROD', url: 'https://bot.exemplo.com/goalfy/webhook/s' }));
    const server = await startWebhookServer(ctx);
    server?.close();
    assert.deepEqual(calls, ['subscribe https://bot.exemplo.com/goalfy/webhook/s']);
  });
});
