/**
 * /topicos: tópicos de uma pessoa no fórum de N2/N3 (padrão: quem executa o comando), com
 * filtros (abertos, sem resposta, com card, encerrados, todos). A resposta é sempre efêmera.
 *
 * "Encerrado" = resolvido / não procede (status do bot ou tag do fórum) ou card na fase final.
 * "Respondido" = alguém além de quem abriu (e além de bots) já escreveu no tópico.
 * Tópicos arquivados pelo Discord por inatividade entram se o processo ainda os acompanha.
 */
import {
  ActionRowBuilder,
  type AnyThreadChannel,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  time,
  TimestampStyles,
} from 'discord.js';
import type { BotContext } from '../context.js';
import { logger } from '../logger.js';
import { normalize, TOPIC_STATUS, type TopicStatus } from '../process.js';
import { forumTagNames, statusTagNames } from './topics.js';
import { COLORS, errorEmbed, truncate } from './ui.js';

const MAX_LINES = 25;

export const TOPIC_FILTERS = {
  abertos: 'Em aberto',
  sem_resposta: 'Sem resposta',
  com_card: 'Com card',
  encerrados: 'Encerrados',
  todos: 'Todos',
} as const;
export type TopicFilter = keyof typeof TOPIC_FILTERS;
export const isTopicFilter = (v: unknown): v is TopicFilter => typeof v === 'string' && v in TOPIC_FILTERS;

export interface TopicItem {
  threadId: string;
  createdAt: Date | null;
  archived: boolean;
  /** Etiquetas do fórum que não são de status (o status já aparece no emoji). */
  tags: string[];
  status?: TopicStatus;
  finished: boolean;
  /** undefined = não verificado (tópico encerrado). */
  answered?: boolean;
  card?: { url: string; phaseName: string | null };
}

export function applyFilter(items: TopicItem[], filter: TopicFilter): TopicItem[] {
  switch (filter) {
    case 'abertos':
      return items.filter((t) => !t.finished);
    case 'sem_resposta':
      return items.filter((t) => !t.finished && t.answered === false);
    case 'com_card':
      return items.filter((t) => !t.finished && t.card);
    case 'encerrados':
      return items.filter((t) => t.finished);
    case 'todos':
      return items;
  }
}

/** Uma linha por tópico: status · tópico · card (fase) · etiquetas extras · sem resposta · idade. */
export function topicLine(t: TopicItem): string {
  const parts = [`${t.status ? TOPIC_STATUS[t.status].emoji : '▫️'} <#${t.threadId}>`];
  if (t.card) parts.push(`[${t.card.phaseName ?? 'card'}](${t.card.url})`);
  if (t.tags.length) parts.push(t.tags.join(', '));
  if (t.answered === false && !t.finished) parts.push('💬 sem resposta');
  if (t.archived) parts.push('_arquivado_');
  if (t.createdAt) parts.push(time(t.createdAt, TimestampStyles.RelativeTime));
  return parts.join(' · ');
}

export function topicsView(all: TopicItem[], filter: TopicFilter, ownerId: string, whoName: string, self: boolean) {
  const items = applyFilter(all, filter).sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  const lines = items.slice(0, MAX_LINES).map(topicLine);
  if (items.length > MAX_LINES) lines.push(`…e mais ${items.length - MAX_LINES}.`);
  const open = all.filter((t) => !t.finished);
  const embed = new EmbedBuilder()
    .setColor(items.length ? COLORS.brand : COLORS.done)
    .setTitle(`🧵 ${self ? 'Seus tópicos' : `Tópicos de ${whoName}`} · ${TOPIC_FILTERS[filter]} (${items.length})`)
    .setDescription(truncate(lines.join('\n') || 'Nenhum tópico neste filtro. 🎉', 4096))
    .setFooter({
      text: `${open.length} em aberto · ${open.filter((t) => t.answered === false).length} sem resposta · ${all.length - open.length} encerrado(s)\n🔎 triagem · ⏳ aguardando info · 📋 card criado · ✅ resolvido · ❌ não procede`,
    });
  const buttons = (Object.keys(TOPIC_FILTERS) as TopicFilter[]).map((f) =>
    new ButtonBuilder()
      .setCustomId(`topics:${f}:${ownerId}`)
      .setLabel(TOPIC_FILTERS[f])
      .setStyle(f === filter ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(f === filter),
  );
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] };
}

/** Alguém além de quem abriu (e além de bots) escreveu no tópico? */
async function wasAnswered(thread: AnyThreadChannel): Promise<boolean | undefined> {
  try {
    const messages = await thread.messages.fetch({ limit: 100 });
    return messages.some((m) => !m.author.bot && m.author.id !== thread.ownerId);
  } catch {
    return undefined;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// Trocar de filtro nos botões não refaz as buscas no Discord por 1 minuto.
const cache = new Map<string, { at: number; items: TopicItem[] }>();
const CACHE_MS = 60_000;

/** Busca no Discord (tópicos ativos) + no banco (acompanhados, mesmo arquivados). */
export async function topicsOf(ctx: BotContext, ownerId: string, fresh = false): Promise<TopicItem[]> {
  const hit = cache.get(ownerId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.items;

  const guild = await ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID);
  const forums = new Set(ctx.config.DISCORD_FORUM_CHANNEL_IDS);
  const threads = new Map<string, AnyThreadChannel>();

  const active = await guild.channels.fetchActiveThreads();
  for (const t of active.threads.values()) {
    if (t.ownerId === ownerId && forums.has(t.parentId ?? '')) threads.set(t.id, t);
  }
  for (const id of ctx.store.trackedTopicsOf(ownerId).slice(0, 25)) {
    if (threads.has(id)) continue;
    const ch = await ctx.client.channels.fetch(id).catch(() => null); // tópico apagado: ignora
    if (ch?.isThread() && forums.has(ch.parentId ?? '')) threads.set(ch.id, ch);
  }

  const tagNames = statusTagNames(ctx);
  const statusTags = new Set(Object.values(tagNames).filter((n): n is string => !!n).map(normalize));
  const closingTags = new Set([tagNames.resolved, tagNames.rejected].filter((n): n is string => !!n).map(normalize));

  const items = await mapLimit([...threads.values()], 5, async (t): Promise<TopicItem> => {
    const link = ctx.store.byThread(t.id);
    const status = ctx.store.topic(t.id)?.status;
    const tags = forumTagNames(t);
    const finished =
      status === 'resolved' || status === 'rejected' || !!link?.closed || tags.some((n) => closingTags.has(normalize(n)));
    return {
      threadId: t.id,
      createdAt: t.createdAt,
      archived: !!t.archived,
      tags: tags.filter((n) => !statusTags.has(normalize(n))),
      status,
      finished,
      answered: finished ? undefined : await wasAnswered(t),
      card: link && { url: ctx.board.cardUrl(link.cardId), phaseName: link.phaseName },
    };
  });
  cache.set(ownerId, { at: Date.now(), items });
  return items;
}

/** Botões de filtro da lista (a mensagem é efêmera: só quem executou vê e clica). */
export async function onTopicsButton(ctx: BotContext, interaction: ButtonInteraction, filter: string, ownerId: string) {
  try {
    await interaction.deferUpdate();
    const who = await ctx.client.users.fetch(ownerId);
    const items = await topicsOf(ctx, ownerId);
    await interaction.editReply(topicsView(items, isTopicFilter(filter) ? filter : 'abertos', ownerId, who.displayName, ownerId === interaction.user.id));
  } catch (e) {
    logger.warn('Filtro de /topicos falhou', e);
    await interaction.followUp({ embeds: [errorEmbed(e)], flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}
