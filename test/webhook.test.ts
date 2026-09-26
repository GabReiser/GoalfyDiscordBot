import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { Server } from 'node:http';
import type { BotContext } from '../src/context.js';
import { BoardService } from '../src/goalfy/board.js';
import { CardService } from '../src/goalfy/cards.js';
import type { GoalfyClient } from '../src/goalfy/client.js';
import { Store } from '../src/store.js';
import { startWebhookServer } from '../src/webhook.js';

const PORT = 38000 + Math.floor(Math.random() * 1000);
const phases = [
  { id: 'p1', index: 0, title: 'Backlog', done: false },
  { id: 'p2', index: 1, title: 'Desenvolvimento', done: false },
  { id: 'p3', index: 2, title: 'Produção', done: true },
];

describe('webhook da Goalfy', () => {
  let cardPhase = 'p1';
  const hooks: string[] = [];
  const client = {
    listPhases: async () => phases,
    getCard: async (id: string) => {
      await new Promise((r) => setTimeout(r, 20)); // simula latência para testar concorrência
      return { id, title: 'X', phase: { id: cardPhase } };
    },
    listComments: async () => ({ comments: [] }),
    subscribeBoardHook: async (_b: string, _e: string, url: string) => {
      hooks.push(url);
      return { id: 'H1' };
    },
    deleteBoardHook: async () => {},
  } as unknown as GoalfyClient;

  const sent: unknown[] = [];
  const thread = { id: 't1', isThread: () => true, parent: null, appliedTags: [], archived: false, send: async (m: unknown) => sent.push(m), setArchived: async () => {} };
  const board = new BoardService(client, { GOALFY_BOARD_ID: 'B1', GOALFY_APP_URL: 'https://app', GOALFY_DONE_PHASES: [] } as never);
  const store = new Store(':memory:');
  store.link({ threadId: 't1', cardId: 'c9', channelId: 'f', createdBy: 'u1', phaseId: 'p1', phaseName: 'Backlog' });

  const ctx = {
    client: { channels: { fetch: async () => thread } },
    config: { WEBHOOK_PUBLIC_URL: 'https://bot.exemplo.com', WEBHOOK_PORT: PORT, WEBHOOK_SECRET: 's3cr3t', SYNC_COMMENTS: false, ARCHIVE_ON_DONE: true, DISCORD_FORUM_CHANNEL_IDS: [] },
    goalfy: client,
    board,
    cards: new CardService(client, board),
    store,
  } as unknown as BotContext;

  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.status);
  const settle = () => new Promise((r) => setTimeout(r, 200));

  it('registra o hook MOVE_CARD_TO com o segredo na URL', async () => {
    servers.push((await startWebhookServer(ctx))!);
    assert.deepEqual(hooks, ['https://bot.exemplo.com/goalfy/webhook/s3cr3t']);
  });

  it('rejeita URL com segredo errado', async () => {
    assert.equal(await post('/goalfy/webhook/errado', { id: 'c9', boardId: 'B1' }), 404);
  });

  it('dois avisos simultâneos geram uma única mensagem no tópico', async () => {
    cardPhase = 'p2';
    const body = { id: 'c9', boardId: 'B1', currentPhase: 'Desenvolvimento' };
    assert.deepEqual(await Promise.all([post('/goalfy/webhook/s3cr3t', body), post('/goalfy/webhook/s3cr3t', body)]), [204, 204]);
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(store.byCard('c9')?.phaseId, 'p2');
  });

  it('fase final encerra o acompanhamento do card', async () => {
    cardPhase = 'p3';
    await post('/goalfy/webhook/s3cr3t', { id: 'c9', boardId: 'B1' });
    await settle();
    assert.equal(store.byCard('c9')?.closed, true);
  });

  it('ignora cards de outros boards', async () => {
    const before = sent.length;
    await post('/goalfy/webhook/s3cr3t', { id: 'c9', boardId: 'OUTRO' });
    await settle();
    assert.equal(sent.length, before);
  });

  it('reinício com a mesma URL reaproveita o hook', async () => {
    servers.splice(0).forEach((s) => s.close());
    servers.push((await startWebhookServer(ctx))!);
    assert.equal(hooks.length, 1);
  });
});
