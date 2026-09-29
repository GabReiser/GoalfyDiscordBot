import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { BotContext } from '../src/context.js';
import { checkDiscordSetup, inviteUrl } from '../src/discord/setup.js';

const ALL_TAGS = ['🔎 Em Triagem', 'Aguardando Informação', 'Card Criado', 'Resolvido', 'Não Procede'];
const ALL_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.PinMessages,
  PermissionFlagsBits.SendMessages,
];

function ctxWith(opts: {
  inGuild?: boolean;
  tags?: string[];
  perms?: bigint[];
  roleExists?: boolean;
  statusTags?: Record<string, string | undefined>;
  /** Canal de logs configurado; "public" = visível para @everyone. */
  logChannel?: 'restricted' | 'public';
}) {
  const perms = new Set(opts.perms ?? ALL_PERMS);
  const permissionsFor = () => ({ has: (flag: bigint) => perms.has(flag) });
  const forum = {
    name: 'n2-n3',
    type: ChannelType.GuildForum,
    availableTags: (opts.tags ?? ALL_TAGS).map((name) => ({ name })),
    permissionsFor,
  };
  const alerts = { isSendable: () => true, permissionsFor };
  const everyone = { id: 'everyone' };
  const logs = {
    name: 'goalfy-bot-logs',
    isSendable: () => true,
    permissionsFor: (who: unknown) =>
      who === everyone ? { has: (flag: bigint) => opts.logChannel === 'public' && flag === PermissionFlagsBits.ViewChannel } : permissionsFor(),
  };
  const guild = {
    members: { me: {} },
    roles: { cache: new Map(opts.roleExists === false ? [] : [['role1', {}]]), everyone },
    channels: { fetch: async (id: string) => ({ forum1: forum, alerts1: alerts, logs1: logs })[id] ?? null },
  };
  return {
    client: { guilds: { cache: new Map(opts.inGuild === false ? [] : [['g1', guild]]) } },
    config: {
      DISCORD_GUILD_ID: 'g1',
      DISCORD_CLIENT_ID: '123456789012345678',
      DISCORD_FORUM_CHANNEL_IDS: ['forum1'],
      DISCORD_TRIAGE_ROLE_IDS: ['role1'],
      DISCORD_TRIAGE_CHANNEL_ID: 'alerts1',
      DISCORD_STATUS_TAGS: opts.statusTags,
      DISCORD_LOG_CHANNEL_ID: opts.logChannel ? 'logs1' : undefined,
    },
  } as unknown as BotContext;
}

describe('checkDiscordSetup', () => {
  it('servidor pronto → sem pendências', async () => {
    assert.deepEqual(await checkDiscordSetup(ctxWith({})), []);
  });

  it('bot fora do servidor → pede o convite com a URL', async () => {
    const [p] = await checkDiscordSetup(ctxWith({ inGuild: false }));
    assert.match(p!, /ainda não está no servidor/);
    assert.ok(p!.includes(inviteUrl('123456789012345678')));
  });

  it('aponta as tags de status que faltam no fórum', async () => {
    const [p, ...rest] = await checkDiscordSetup(ctxWith({ tags: ['Em Triagem', 'Resolvido'] }));
    assert.equal(rest.length, 0);
    assert.match(p!, /faltam as tags "Aguardando Informação" \(waiting\), "Card Criado" \(card\), "Não Procede" \(rejected\)/);
    assert.match(p!, /DISCORD_STATUS_TAGS/);
  });

  it('aponta permissões que faltam (aceita Manage Messages no lugar de Pin Messages)', async () => {
    const semGerenciar = ALL_PERMS.filter((p) => p !== PermissionFlagsBits.ManageThreads && p !== PermissionFlagsBits.PinMessages);
    const [p] = await checkDiscordSetup(ctxWith({ perms: semGerenciar }));
    assert.match(p!, /Gerenciar tópicos/);
    assert.match(p!, /Fixar mensagens/);

    const comManageMessages = [...ALL_PERMS.filter((x) => x !== PermissionFlagsBits.PinMessages), PermissionFlagsBits.ManageMessages];
    assert.deepEqual(await checkDiscordSetup(ctxWith({ perms: comManageMessages })), []);
  });

  it('fórum existente (#suporte-n2): status mapeados para tags que já existem, os demais desligados', async () => {
    const forumTags = ['🔥 Major', 'Atenção Especial', 'Regressão', 'Pendente', 'Resolvido', 'Aguardando Validação', 'Sprint', 'N2'];
    const statusTags = { triage: 'Pendente', waiting: undefined, card: undefined, resolved: 'Resolvido', rejected: undefined };
    assert.deepEqual(await checkDiscordSetup(ctxWith({ tags: forumTags, statusTags })), []);

    const [p] = await checkDiscordSetup(ctxWith({ tags: forumTags, statusTags: { ...statusTags, card: 'Card Criado' } }));
    assert.match(p!, /faltam as tags "Card Criado" \(card\)/);
  });

  it('canal de logs restrito → ok; visível para @everyone → aviso', async () => {
    assert.deepEqual(await checkDiscordSetup(ctxWith({ logChannel: 'restricted' })), []);
    const [p] = await checkDiscordSetup(ctxWith({ logChannel: 'public' }));
    assert.match(p!, /canal de logs #goalfy-bot-logs está visível para @everyone/);
  });

  it('cargo de triagem inexistente', async () => {
    assert.deepEqual(await checkDiscordSetup(ctxWith({ roleExists: false })), ['Cargo de triagem role1 não existe no servidor.']);
  });
});
