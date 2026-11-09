/**
 * Anúncio de novidades (src/changelog.ts). Cada entrada vai para o canal do seu público:
 *  - `team` (padrão): DISCORD_UPDATES_CHANNEL_ID, modo de uso para o suporte/triagem;
 *  - `devs`: DISCORD_DEV_UPDATES_CHANNEL_ID (vazio = canal de alertas, DISCORD_LOG_CHANNEL_ID), ajustes internos.
 * Na inicialização, posta as entradas ainda não postadas (mais antiga primeiro) e as marca no banco.
 * Se o canal não estiver configurado ou acessível, não marca nada: tenta de novo no próximo início.
 */
import { EmbedBuilder } from 'discord.js';
import { CHANGELOG, type ChangelogEntry } from '../changelog.js';
import type { BotConfig } from '../config.js';
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

/** Canal de cada público. */
export function updatesChannelFor(config: Pick<BotConfig, 'DISCORD_UPDATES_CHANNEL_ID' | 'DISCORD_DEV_UPDATES_CHANNEL_ID' | 'DISCORD_LOG_CHANNEL_ID'>, entry: ChangelogEntry) {
  return entry.audience === 'devs' ? (config.DISCORD_DEV_UPDATES_CHANNEL_ID ?? config.DISCORD_LOG_CHANNEL_ID) : config.DISCORD_UPDATES_CHANNEL_ID;
}

export const updateEmbed = (e: ChangelogEntry) =>
  new EmbedBuilder()
    .setColor(e.audience === 'devs' ? COLORS.info : COLORS.brand)
    .setTitle(truncate(e.title, 256))
    .setDescription(truncate(e.body.join('\n'), 4096));

async function postTo(ctx: BotContext, id: string, entries: ChangelogEntry[], heading: string) {
  const channel = await ctx.client.channels.fetch(id).catch(() => null);
  if (!channel?.isSendable()) {
    logger.warn(`Não consegui postar as novidades no canal ${id} (preciso de ver canal, enviar mensagens e inserir links).`);
    return;
  }
  // Até 10 embeds por mensagem.
  for (let i = 0; i < entries.length; i += 10) {
    const batch = entries.slice(i, i + 10);
    try {
      await channel.send({ content: i === 0 ? heading : undefined, embeds: batch.map(updateEmbed), allowedMentions: { parse: [] } });
      markPosted(ctx.store, batch.map((e) => e.id));
    } catch (e) {
      logger.warn(`Falha ao postar novidades no canal ${id}`, e);
      return;
    }
  }
  logger.info(`${entries.length} novidade(s) anunciada(s) no canal ${id}`);
}

export async function postUpdates(ctx: BotContext) {
  const byChannel = new Map<string, { entries: ChangelogEntry[]; devs: boolean }>();
  for (const entry of pendingEntries(ctx.store)) {
    const id = updatesChannelFor(ctx.config, entry);
    if (!id) continue;
    const group = byChannel.get(id) ?? { entries: [], devs: entry.audience === 'devs' };
    group.entries.push(entry);
    byChannel.set(id, group);
  }
  for (const [id, { entries, devs }] of byChannel) {
    await postTo(ctx, id, entries, devs ? '🛠️ **Ajustes internos do Goalfy Bot**' : '🆕 **Novidades do Goalfy Bot**');
  }
}
