/**
 * /topicos: tópicos abertos de uma pessoa no fórum de N2/N3 (padrão: quem executa o comando),
 * com etiquetas, status do processo e o card vinculado na Goalfy.
 *
 * "Aberto" = tópico ativo no Discord, ou que o processo ainda acompanha (sem destino, ou com card
 * ainda fora da fase final), mesmo que o Discord o tenha arquivado por inatividade.
 */
import { type AnyThreadChannel, EmbedBuilder, time, TimestampStyles } from 'discord.js';
import type { BotContext } from '../context.js';
import { TOPIC_STATUS, type TopicStatus } from '../process.js';
import type { CardLink } from '../store.js';
import { forumTagNames } from './topics.js';
import { COLORS, truncate } from './ui.js';

const MAX_LINES = 20;

export interface TopicItem {
  threadId: string;
  title: string;
  createdAt: Date | null;
  archived: boolean;
  tags: string[];
  status?: TopicStatus;
  card?: Pick<CardLink, 'cardId' | 'phaseName' | 'closed'> & { url: string };
}

/** Uma linha por tópico: link, título, etiquetas, card (com a fase) e quando foi aberto. */
export function topicLine(t: TopicItem): string {
  const status = t.status ? `${TOPIC_STATUS[t.status].emoji} ` : '';
  const head = `${status}<#${t.threadId}> **${truncate(t.title, 70)}**${t.archived ? ' _(arquivado)_' : ''}`;
  const tags = t.tags.length ? `🏷️ ${t.tags.join(', ')}` : '🏷️ _sem etiqueta_';
  const card = t.card
    ? `📋 [#${t.card.cardId}](${t.card.url})${t.card.phaseName ? ` · _${t.card.phaseName}_` : ''}${t.card.closed ? ' (encerrado)' : ''}`
    : '📋 _sem card_';
  const opened = t.createdAt ? `aberto ${time(t.createdAt, TimestampStyles.RelativeTime)}` : '';
  return `${head}\n${[tags, card, opened].filter(Boolean).join(' · ')}`;
}

/** Mais recentes primeiro; no máximo MAX_LINES, avisando quantos ficaram de fora. */
export function topicsEmbed(items: TopicItem[], whoName: string, self: boolean): EmbedBuilder {
  const sorted = [...items].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  const shown = sorted.slice(0, MAX_LINES).map(topicLine);
  if (sorted.length > MAX_LINES) shown.push(`…e mais ${sorted.length - MAX_LINES}.`);
  const withCard = items.filter((t) => t.card).length;
  return new EmbedBuilder()
    .setColor(items.length ? COLORS.brand : COLORS.done)
    .setTitle(`🧵 ${self ? 'Seus tópicos abertos' : `Tópicos abertos de ${whoName}`} (${items.length})`)
    .setDescription(truncate(shown.join('\n\n') || (self ? 'Você não tem tópicos abertos no fórum de N2/N3. 🎉' : 'Nenhum tópico aberto.'), 4096))
    .setFooter({ text: `${withCard} com card na Goalfy · ${items.length - withCard} sem card` });
}

/** Busca no Discord (tópicos ativos) + no banco (acompanhados, mesmo arquivados). */
export async function openTopicsOf(ctx: BotContext, ownerId: string): Promise<TopicItem[]> {
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

  return [...threads.values()].map((t) => {
    const link = ctx.store.byThread(t.id);
    return {
      threadId: t.id,
      title: t.name,
      createdAt: t.createdAt,
      archived: !!t.archived,
      tags: forumTagNames(t),
      status: ctx.store.topic(t.id)?.status,
      card: link && { cardId: link.cardId, phaseName: link.phaseName, closed: link.closed, url: ctx.board.cardUrl(link.cardId) },
    };
  });
}
