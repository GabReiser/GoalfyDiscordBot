/**
 * Menu de mensagem "Anexar ao card Goalfy": arquivos da mensagem → campo de anexo do card,
 * sem comentário e sem duplicar o que já foi copiado (criação, "Enviar", clique repetido).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { BotContext } from '../src/context.js';
import { onAttachToCard } from '../src/discord/commands.js';
import { Store } from '../src/store.js';

const URL_OK = 'https://cdn.discordapp.com/attachments/1/2/print.png?ex=1';
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function setup() {
  const store = new Store(':memory:');
  store.link({ threadId: 't1', cardId: 'c1', channelId: 'f', createdBy: 'u1', phaseId: null, phaseName: null });
  const appended: string[][] = [];
  const comments: string[] = [];
  const ctx = {
    store,
    board: { cardUrl: (id: string) => `https://app/board/B1/cards/${id}` },
    cards: {
      appendAttachments: async (_cardId: string, list: { name: string; url: string }[]) => {
        appended.push(list.map((a) => a.name));
        return { copied: list.map((a) => a.name), failed: [], copiedUrls: new Set(list.map((a) => a.url)), fieldName: 'Anexo' };
      },
      comment: async (_id: string, text: string) => comments.push(text),
    },
  } as unknown as BotContext;
  return { ctx, store, appended, comments };
}

function interaction(attachments: { id: string; name: string; url: string }[], channelId = 't1') {
  const replies: { content?: string; embeds?: { toJSON(): { description?: string } }[] }[] = [];
  const map = new Map(attachments.map((a) => [a.id, { ...a, contentType: 'image/png', size: 3 }]));
  return {
    replies,
    i: {
      channelId,
      user: { tag: 'ana' },
      targetMessage: { attachments: map },
      reply: async (p: never) => replies.push(p),
      deferReply: async () => {},
      editReply: async (p: never) => replies.push(p),
    } as never,
  };
}

const text = (r: { content?: string; embeds?: { toJSON(): { description?: string } }[] }) => r.content ?? r.embeds?.[0]?.toJSON().description ?? '';

describe('Anexar ao card Goalfy', () => {
  it('anexa os arquivos da mensagem ao campo de anexo, sem comentar', async () => {
    const { ctx, appended, comments } = setup();
    const { i, replies } = interaction([{ id: 'a1', name: 'print.png', url: URL_OK }]);
    await onAttachToCard(ctx, i);
    assert.deepEqual(appended, [['print.png']]);
    assert.deepEqual(comments, [], 'não cria comentário');
    assert.match(text(replies.at(-1)!), /Anexado ao card .*campo Anexo.*print\.png/);
  });

  it('clicar de novo na mesma mensagem não duplica', async () => {
    const { ctx, appended } = setup();
    const first = interaction([{ id: 'a1', name: 'print.png', url: URL_OK }]);
    await onAttachToCard(ctx, first.i);
    const second = interaction([{ id: 'a1', name: 'print.png', url: URL_OK }]);
    await onAttachToCard(ctx, second.i);
    assert.equal(appended.length, 1, 'só a primeira vez envia');
    assert.match(text(second.replies.at(-1)!), /Já estava no card: print\.png/);
  });

  it('evidência já copiada na criação do card também não duplica', async () => {
    const { ctx, store, appended } = setup();
    store.markAttachmentsImported('c1', ['a1']);
    const { i } = interaction([
      { id: 'a1', name: 'print.png', url: URL_OK },
      { id: 'a2', name: 'log.txt', url: URL_OK + '2' },
    ]);
    await onAttachToCard(ctx, i);
    assert.deepEqual(appended, [['log.txt']]);
  });

  it('mensagem sem arquivo ou tópico sem card: avisa e não faz nada', async () => {
    const { ctx, appended } = setup();
    const empty = interaction([]);
    await onAttachToCard(ctx, empty.i);
    assert.match(text(empty.replies[0]!), /não tem imagens nem arquivos/);
    const other = interaction([{ id: 'a1', name: 'x.png', url: URL_OK }], 'outro-canal');
    await onAttachToCard(ctx, other.i);
    assert.match(text(other.replies[0]!), /não está vinculado a um card/);
    assert.equal(appended.length, 0);
  });
});
