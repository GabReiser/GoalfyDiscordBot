import {
  type AnyThreadChannel,
  ChannelType,
  type Interaction,
  MessageFlags,
  PermissionFlagsBits,
  type RepliableInteraction,
} from 'discord.js';
import type { BotContext } from '../context.js';
import type { Phase } from '../goalfy/types.js';
import { logger } from '../logger.js';
import { DESTINATION_STATUSES, normalize, TOPIC_STATUS, type TopicStatus } from '../process.js';

export const isMonitoredForum = (ctx: BotContext, thread: AnyThreadChannel) =>
  thread.parent?.type === ChannelType.GuildForum && ctx.config.DISCORD_FORUM_CHANNEL_IDS.includes(thread.parentId ?? '');

export function forumTagNames(thread: AnyThreadChannel): string[] {
  const forum = thread.parent;
  if (forum?.type !== ChannelType.GuildForum) return [];
  return thread.appliedTags.map((id) => forum.availableTags.find((t) => t.id === id)?.name).filter((n): n is string => !!n);
}

/**
 * Troca, dentro de um "grupo" de tags do fórum, a tag aplicada no tópico.
 * Tags fora do grupo ficam intactas. Se a tag alvo não existir no fórum, só remove as do grupo.
 */
async function replaceTagGroup(thread: AnyThreadChannel, group: Set<string>, target: string | undefined) {
  const forum = thread.parent;
  if (forum?.type !== ChannelType.GuildForum) return;

  const groupIds = new Set(forum.availableTags.filter((t) => group.has(normalize(t.name))).map((t) => t.id));
  const targetTag = target ? forum.availableTags.find((t) => normalize(t.name) === normalize(target)) : undefined;

  const next = thread.appliedTags.filter((id) => !groupIds.has(id));
  if (targetTag) next.unshift(targetTag.id);
  const tags = next.slice(0, 5);

  const same = tags.length === thread.appliedTags.length && tags.every((t) => thread.appliedTags.includes(t));
  if (same) return;
  if (thread.archived) await thread.setArchived(false).catch(() => {});
  await thread.setAppliedTags(tags).catch((e) => logger.warn(`Não consegui trocar as tags do tópico ${thread.id}`, e));
}

/** Nome da tag do fórum para cada status (DISCORD_STATUS_TAGS). `undefined` = status sem tag. */
export function statusTagNames(ctx: BotContext): Record<TopicStatus, string | undefined> {
  return (
    ctx.config.DISCORD_STATUS_TAGS ??
    (Object.fromEntries(Object.entries(TOPIC_STATUS).map(([k, v]) => [k, v.tag])) as Record<TopicStatus, string>)
  );
}

/** Atualiza o status do tópico (seção 14): banco + tag do fórum. */
export async function setTopicStatus(ctx: BotContext, thread: AnyThreadChannel, status: TopicStatus) {
  if (isMonitoredForum(ctx, thread)) {
    ctx.store.openTopic(thread.id, thread.ownerId ?? '', thread.name);
    ctx.store.setStatus(thread.id, status, DESTINATION_STATUSES.has(status));
  }
  // Só as tags mapeadas para status formam o grupo: tags do solicitante (Major, Regressão…) ficam intactas.
  // Status sem tag mapeada não mexe nas tags: o fórum pode exigir tag, e remover a atual deixaria o tópico sem nenhuma.
  const names = statusTagNames(ctx);
  if (!names[status]) return;
  const group = new Set(Object.values(names).filter((n): n is string => !!n).map(normalize));
  await replaceTagGroup(thread, group, names[status]);
}

/** Opcional: se o fórum tiver tags com o nome das fases do board, espelha a fase atual. */
export async function applyPhaseTag(ctx: BotContext, thread: AnyThreadChannel, phase: Phase | undefined) {
  if (!phase) return;
  const phaseNames = new Set((await ctx.board.phases()).map((p) => normalize(p.title)));
  await replaceTagGroup(thread, phaseNames, phase.title);
}

export async function closeThread(thread: AnyThreadChannel, reason: string) {
  await thread.setArchived(true, reason).catch((e) => logger.warn(`Não consegui arquivar o tópico ${thread.id}`, e));
}

/** Triagem = cargos configurados, ou quem pode gerenciar tópicos. Sem cargos configurados, todos. */
export function isTriage(ctx: BotContext, interaction: Interaction): boolean {
  const roles = ctx.config.DISCORD_TRIAGE_ROLE_IDS;
  if (!roles.length) return true;
  if (!interaction.inCachedGuild()) return false;
  return interaction.member.roles.cache.hasAny(...roles) || interaction.memberPermissions.has(PermissionFlagsBits.ManageThreads);
}

export async function requireTriage(ctx: BotContext, interaction: RepliableInteraction): Promise<boolean> {
  if (isTriage(ctx, interaction)) return true;
  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: '🔒 Só a equipe de triagem N2/N3 pode fazer isso. Quem abriu o tópico não precisa decidir frente, prioridade ou prazo. 🙂',
  });
  return false;
}
