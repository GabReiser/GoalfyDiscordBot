import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType } from 'discord.js';
import type { BotContext } from '../src/context.js';
import { setTopicStatus } from '../src/discord/topics.js';

/** Fórum #suporte-n2 como existe hoje, com as tags escolhidas pelo solicitante preservadas. */
function forumThread(applied: string[]) {
  const availableTags = ['Major', 'Atenção Especial', 'Regressão', 'Pendente', 'Resolvido', 'Aguardando Validação', 'Sprint', 'N2'].map(
    (name, i) => ({ id: `t${i}`, name }),
  );
  const idOf = (name: string) => availableTags.find((t) => t.name === name)!.id;
  const thread = {
    id: 'th1',
    parentId: 'forum1',
    parent: { type: ChannelType.GuildForum, availableTags },
    appliedTags: applied.map(idOf),
    archived: false,
    setAppliedTags: async (ids: string[]) => {
      thread.appliedTags = ids;
    },
    setArchived: async () => {},
  };
  const names = () => thread.appliedTags.map((id) => availableTags.find((t) => t.id === id)!.name);
  return { thread, names };
}

const ctx = {
  config: {
    DISCORD_FORUM_CHANNEL_IDS: [], // fora dos fóruns monitorados: não toca no banco
    DISCORD_STATUS_TAGS: { triage: 'Pendente', waiting: undefined, card: undefined, resolved: 'Resolvido', rejected: undefined },
  },
} as unknown as BotContext;

describe('setTopicStatus com tags do fórum existente', () => {
  it('troca a tag de status e preserva as tags do solicitante', async () => {
    const { thread, names } = forumThread(['Major', 'Regressão']);
    await setTopicStatus(ctx, thread as never, 'triage');
    assert.deepEqual(names(), ['Pendente', 'Major', 'Regressão']);

    await setTopicStatus(ctx, thread as never, 'resolved');
    assert.deepEqual(names(), ['Resolvido', 'Major', 'Regressão']);
  });

  it('status sem tag mapeada não mexe nas tags (o fórum exige ao menos uma)', async () => {
    const { thread, names } = forumThread(['Pendente']);
    await setTopicStatus(ctx, thread as never, 'waiting');
    assert.deepEqual(names(), ['Pendente']);
  });
});
