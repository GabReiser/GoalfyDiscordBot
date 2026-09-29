import { ChannelType, type Guild, PermissionFlagsBits } from 'discord.js';
import type { BotContext } from '../context.js';
import { logger } from '../logger.js';
import { normalize, TOPIC_STATUS, type TopicStatus } from '../process.js';
import { commandData } from './commands.js';
import { statusTagNames } from './topics.js';

/** Permissões que o bot precisa (as mesmas da URL de convite). */
const INVITE_PERMISSIONS = 2252091871546432n;

export const inviteUrl = (clientId: string) =>
  `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}`;

const FORUM_PERMISSIONS = {
  'Ver canal': PermissionFlagsBits.ViewChannel,
  'Enviar mensagens em tópicos': PermissionFlagsBits.SendMessagesInThreads,
  'Inserir links (embeds)': PermissionFlagsBits.EmbedLinks,
  'Ler histórico de mensagens': PermissionFlagsBits.ReadMessageHistory,
  'Gerenciar tópicos (tags e arquivar)': PermissionFlagsBits.ManageThreads,
} as const;

/**
 * Confere se o servidor está pronto para o bot e devolve a lista de pendências.
 * Não altera nada no Discord.
 */
export async function checkDiscordSetup(ctx: BotContext): Promise<string[]> {
  const cfg = ctx.config;
  const guild = ctx.client.guilds.cache.get(cfg.DISCORD_GUILD_ID);
  if (!guild) {
    return [`O bot ainda não está no servidor ${cfg.DISCORD_GUILD_ID}. Um admin precisa abrir: ${inviteUrl(cfg.DISCORD_CLIENT_ID)}`];
  }

  const problems: string[] = [];
  const me = guild.members.me ?? (await guild.members.fetchMe());

  if (!cfg.DISCORD_FORUM_CHANNEL_IDS.length) problems.push('DISCORD_FORUM_CHANNEL_IDS está vazio: nenhum fórum será monitorado.');
  for (const id of cfg.DISCORD_FORUM_CHANNEL_IDS) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!channel) {
      problems.push(`Fórum ${id} não encontrado, ou o bot não tem acesso a ele.`);
      continue;
    }
    if (channel.type !== ChannelType.GuildForum) {
      problems.push(`#${channel.name} (${id}) não é um canal de fórum.`);
      continue;
    }
    const tags = new Set(channel.availableTags.map((t) => normalize(t.name)));
    const names = statusTagNames(ctx);
    const missingTags = (Object.keys(TOPIC_STATUS) as TopicStatus[])
      .filter((s) => names[s] && !tags.has(normalize(names[s]!)))
      .map((s) => `"${names[s]}" (${s})`);
    if (missingTags.length) {
      problems.push(
        `Fórum #${channel.name}: faltam as tags ${missingTags.join(', ')}. ` +
          'Crie no fórum, aponte para uma tag existente ou desligue o status em DISCORD_STATUS_TAGS.',
      );
    }

    const perms = channel.permissionsFor(me);
    const missingPerms = Object.entries(FORUM_PERMISSIONS)
      .filter(([, flag]) => !perms.has(flag))
      .map(([name]) => name);
    if (!perms.has(PermissionFlagsBits.PinMessages) && !perms.has(PermissionFlagsBits.ManageMessages)) {
      missingPerms.push('Fixar mensagens');
    }
    if (missingPerms.length) problems.push(`Fórum #${channel.name}: o bot não tem ${missingPerms.join(', ')}.`);
  }

  for (const id of cfg.DISCORD_TRIAGE_ROLE_IDS) {
    if (!guild.roles.cache.has(id)) problems.push(`Cargo de triagem ${id} não existe no servidor.`);
  }
  if (!cfg.DISCORD_TRIAGE_ROLE_IDS.length) {
    problems.push('DISCORD_TRIAGE_ROLE_IDS está vazio: qualquer pessoa poderá criar cards e mudar status.');
  }

  if (cfg.DISCORD_TRIAGE_CHANNEL_ID) {
    const channel = await guild.channels.fetch(cfg.DISCORD_TRIAGE_CHANNEL_ID).catch(() => null);
    if (!channel?.isSendable() || !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
      problems.push(`Não consigo escrever no canal de tópicos parados ${cfg.DISCORD_TRIAGE_CHANNEL_ID}.`);
    }
  }

  if (cfg.DISCORD_LOG_CHANNEL_ID) {
    const channel = await guild.channels.fetch(cfg.DISCORD_LOG_CHANNEL_ID).catch(() => null);
    const perms = channel && 'permissionsFor' in channel ? channel.permissionsFor(me) : null;
    const canPost =
      channel?.isSendable() &&
      perms?.has(PermissionFlagsBits.ViewChannel) &&
      perms.has(PermissionFlagsBits.SendMessages) &&
      perms.has(PermissionFlagsBits.EmbedLinks);
    if (!canPost) {
      problems.push(`Não consigo postar no canal de logs ${cfg.DISCORD_LOG_CHANNEL_ID} (preciso de ver canal, enviar mensagens e inserir links).`);
    } else if ('permissionsFor' in channel && channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
      // Os alertas trazem IDs de card, nomes e erros da Goalfy: o canal deve ser restrito.
      problems.push(`O canal de logs #${'name' in channel ? channel.name : cfg.DISCORD_LOG_CHANNEL_ID} está visível para @everyone. Restrinja ao cargo de triagem.`);
    }
  }
  return problems;
}

/** Registra os slash commands no servidor. Idempotente: a mesma lista sobrescreve a anterior. */
async function registerCommands(ctx: BotContext, guild: Guild) {
  await ctx.client.application!.commands.set(commandData, guild.id);
  logger.info(`Slash commands registrados em "${guild.name}"`);
}

/** Registra os comandos (se o bot já estiver no servidor) e loga o diagnóstico. */
export async function prepareGuild(ctx: BotContext) {
  const guild = ctx.client.guilds.cache.get(ctx.config.DISCORD_GUILD_ID);
  if (guild) await registerCommands(ctx, guild).catch((e) => logger.error('Falha ao registrar os slash commands', e));

  const problems = await checkDiscordSetup(ctx).catch((e) => [`Falha ao verificar o servidor: ${(e as Error).message}`]);
  if (!problems.length) logger.info('Servidor do Discord pronto: fórum, tags, permissões e cargos ok.');
  else for (const p of problems) logger.warn(`[setup] ${p}`);
}
