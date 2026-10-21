/**
 * Anúncio de novidades (src/changelog.ts) no canal DISCORD_UPDATES_CHANNEL_ID.
 * Na inicialização, posta as entradas ainda não postadas (mais antiga primeiro) e as marca no banco.
 * Se o canal não estiver acessível, não marca nada: tenta de novo no próximo início.
 */
import { EmbedBuilder } from 'discord.js';
import { CHANGELOG, type ChangelogEntry } from '../changelog.js';
import type { BotContext } from '../context.js';
import { logger } from '../logger.js';
import type { Store } from '../store.js';
import { COLORS, truncate } from './ui.js';

const KEY = 'updates:posted';

export function pendingEntries(store: Store, entries: ChangelogEntry[] = CHANGELOG): ChangelogEntry[] {
  let posted: string[] = [];
  try {
    posted = JSON.parse(store.get(KEY) ?? '[]') as string[];
  } catch {
    // valor corrompido: trata como nada postado
  }
  return entries.filter((e) => !posted.includes(e.id)).reverse();
}

export function markPosted(store: Store, ids: string[]) {
  let posted: string[] = [];
  try {
    posted = JSON.parse(store.get(KEY) ?? '[]') as string[];
  } catch {}
  store.set(KEY, JSON.stringify([...new Set([...posted, ...ids])]));
}

export const updateEmbed = (e: ChangelogEntry) =>
  new EmbedBuilder().setColor(COLORS.brand).setTitle(truncate(e.title, 256)).setDescription(truncate(e.body.join('\n'), 4096));

export async function postUpdates(ctx: BotContext) {
  const id = ctx.config.DISCORD_UPDATES_CHANNEL_ID;
  if (!id) return;
  const pending = pendingEntries(ctx.store);
  if (!pending.length) return;

  const channel = await ctx.client.channels.fetch(id).catch(() => null);
  if (!channel?.isSendable()) {
    logger.warn(`Não consegui postar as novidades no canal ${id} (preciso de ver canal, enviar mensagens e inserir links).`);
    return;
  }
  // Até 10 embeds por mensagem.
  for (let i = 0; i < pending.length; i += 10) {
    const batch = pending.slice(i, i + 10);
    try {
      await channel.send({ content: i === 0 ? '🆕 **Novidades do Goalfy Bot**' : undefined, embeds: batch.map(updateEmbed), allowedMentions: { parse: [] } });
      markPosted(ctx.store, batch.map((e) => e.id));
    } catch (e) {
      logger.warn(`Falha ao postar novidades no canal ${id}`, e);
      return;
    }
  }
  logger.info(`${pending.length} novidade(s) anunciada(s) no canal ${id}`);
}
