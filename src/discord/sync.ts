import { type AnyThreadChannel, EmbedBuilder, time, TimestampStyles } from 'discord.js';
import type { BotContext } from '../context.js';
import { GoalfyError } from '../goalfy/client.js';
import { type Card, commentText, isFilled, type Phase, parseApiDate, toComments } from '../goalfy/types.js';
import { logger } from '../logger.js';
import { BOT_COMMENT_PREFIX } from '../process.js';
import type { CardLink } from '../store.js';
import { applyPhaseTag, closeThread, setTopicStatus } from './topics.js';
import { COLORS, truncate } from './ui.js';

export async function fetchThread(ctx: BotContext, threadId: string): Promise<AnyThreadChannel | undefined> {
  try {
    const ch = await ctx.client.channels.fetch(threadId);
    return ch?.isThread() ? ch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registra uma mudança de fase: atualiza o banco, avisa no tópico, espelha a
 * fase nas tags e, se for fase final, marca o tópico como Resolvido e encerra.
 */
export async function applyPhaseChange(
  ctx: BotContext,
  link: CardLink,
  phase: Phase | undefined,
  opts: { by?: string; card?: Card } = {},
) {
  const done = phase ? ctx.board.isDone(phase) : false;
  const cancelled = phase ? ctx.board.isCancel(phase) : false;
  const from = link.phaseName ?? '—';
  const to = phase?.title ?? '—';
  ctx.store.updatePhase(link.cardId, phase?.id ?? null, phase?.title ?? null, done);

  const thread = await fetchThread(ctx, link.threadId);
  if (!thread) return;

  const embed = new EmbedBuilder()
    .setColor(cancelled ? COLORS.muted : done ? COLORS.done : COLORS.info)
    .setTitle(cancelled ? '❌ Card cancelado/arquivado' : done ? '✅ Demanda entregue' : '🔀 Card mudou de fase')
    .setDescription(`**${from}** → **${to}**`)
    .setURL(ctx.board.cardUrl(link.cardId))
    .setFooter({ text: `Card #${link.cardId}${opts.by ? ` · movido por ${opts.by}` : ''}` })
    .setTimestamp();
  if (cancelled && phase && opts.card) {
    const reason = await phaseFormText(ctx, opts.card, phase);
    if (reason) embed.addFields({ name: 'Motivo', value: truncate(reason, 1024) });
  } else if (done) {
    embed.addFields({ name: '\u200b', value: 'Se o problema voltar a acontecer, responda aqui neste tópico. 🙌' });
  }

  await thread.send({ content: done ? `<@${link.createdBy}>` : undefined, embeds: [embed] });
  await applyPhaseTag(ctx, thread, phase);
  if (done) {
    await setTopicStatus(ctx, thread, cancelled ? 'rejected' : 'resolved');
    if (ctx.config.ARCHIVE_ON_DONE) await closeThread(thread, cancelled ? 'Card cancelado na Goalfy' : 'Card entregue na Goalfy');
  }
}

/** Primeiro texto preenchido no formulário de uma fase do card (ex.: "Motivo do arquivamento"). */
async function phaseFormText(ctx: BotContext, card: Card, phase: Phase): Promise<string | undefined> {
  const history = card.phaseForms.find((h) => h.phaseId === phase.id);
  if (!history) return undefined;
  const fields = await ctx.board.phaseFields(phase).catch(() => []);
  const textIds = new Set(fields.filter((f) => /text/.test(f.type)).map((f) => f.fieldInfoId));
  const hit = history.fields.find((f) => textIds.has(f.infoId) && isFilled(f.value));
  return hit ? commentText(String(hit.value)) || String(hit.value) : undefined;
}

/** Marca como vistos os comentários atuais do card (para não despejar o histórico no tópico). */
export async function primeComments(ctx: BotContext, cardId: string) {
  try {
    const comments = toComments(await ctx.goalfy.listComments(cardId));
    ctx.store.markSeen(cardId, comments.map((c) => c.id));
  } catch (e) {
    logger.warn(`Não consegui ler comentários do card ${cardId}`, e);
  }
}

async function syncComments(ctx: BotContext, link: CardLink) {
  const comments = toComments(await ctx.goalfy.listComments(link.cardId));
  const fresh = ctx.store.markSeen(link.cardId, comments.map((c) => c.id));
  const toPost = comments.filter((c) => fresh.has(c.id) && c.text && !c.text.startsWith(BOT_COMMENT_PREFIX));
  if (!toPost.length) return;

  const thread = await fetchThread(ctx, link.threadId);
  if (!thread) return;
  for (const c of toPost) {
    await thread.send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.brand)
          .setAuthor({ name: `💬 ${c.author ?? 'Goalfy'} comentou no card` })
          .setDescription(truncate(c.text, 4000))
          .setURL(ctx.board.cardUrl(link.cardId))
          .setTimestamp(parseApiDate(c.createdAt) ?? new Date()),
      ],
    });
  }
}

/** Falhas seguidas de acesso por card (403), antes de encerrar o acompanhamento. */
const unreachable = new Map<string, number>();
const MAX_UNREACHABLE = 3;

async function syncLink(ctx: BotContext, link: CardLink, opts: { by?: string; comments?: boolean }) {
  let card;
  try {
    card = await ctx.cards.get(link.cardId);
  } catch (e) {
    // A Goalfy responde 403 "Card não encontrado ou você não possui acesso" também para card
    // inexistente. Um 403 pode ser passageiro (permissão ajustada), então só desiste após algumas vezes.
    if (e instanceof GoalfyError && (e.status === 404 || e.status === 403)) {
      const failures = (unreachable.get(link.cardId) ?? 0) + 1;
      unreachable.set(link.cardId, failures);
      if (e.status === 403 && failures < MAX_UNREACHABLE) {
        logger.warn(`Sem acesso ao card ${link.cardId} (403, tentativa ${failures}/${MAX_UNREACHABLE})`);
        return;
      }
      unreachable.delete(link.cardId);
      ctx.store.updatePhase(link.cardId, link.phaseId, link.phaseName, true);
      logger.warn(`Card ${link.cardId} inacessível (${e.status}); acompanhamento encerrado`);
      const thread = await fetchThread(ctx, link.threadId);
      await thread?.send(
        `🗑️ Não consigo mais acessar o card #${link.cardId} na Goalfy (foi excluído ou o bot perdeu o acesso). Paro de acompanhar este tópico.`,
      );
      return;
    }
    throw e;
  }
  unreachable.delete(link.cardId);

  const phase = await ctx.board.phaseOf(card);
  const changed = phase ? phase.id !== link.phaseId : !!card.phaseName && card.phaseName !== link.phaseName;
  if (changed) await applyPhaseChange(ctx, link, phase, { by: opts.by, card });
  if (opts.comments ?? ctx.config.SYNC_COMMENTS) await syncComments(ctx, link);
}

const locks = new Map<string, Promise<void>>();

/** Serializa o trabalho por card: webhook, polling e comandos podem disparar ao mesmo tempo. */
function withCardLock(cardId: string, fn: () => Promise<void>): Promise<void> {
  const next = (locks.get(cardId) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(cardId, next);
  next
    .finally(() => {
      if (locks.get(cardId) === next) locks.delete(cardId);
    })
    .catch(() => {});
  return next;
}

/**
 * Re-sincroniza um card vinculado com a Goalfy (fase + comentários).
 * O vínculo é relido dentro do lock, então duas chamadas seguidas não anunciam a mesma mudança duas vezes.
 */
export function syncCard(ctx: BotContext, cardId: string, opts: { by?: string; comments?: boolean } = {}) {
  return withCardLock(cardId, async () => {
    const link = ctx.store.byCard(cardId);
    if (link && !link.closed) await syncLink(ctx, link, opts);
  });
}

/** Regra 8: nenhum tópico fica sem destino. Avisa a triagem sobre tópicos parados. */
async function remindStaleTopics(ctx: BotContext) {
  const { DISCORD_TRIAGE_CHANNEL_ID: channelId, STALE_TOPIC_HOURS: hours } = ctx.config;
  if (!channelId || hours <= 0) return;

  const stale = ctx.store.staleTopics(hours);
  if (!stale.length) return;

  const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isSendable()) {
    logger.warn(`DISCORD_TRIAGE_CHANNEL_ID ${channelId} não é um canal onde consigo escrever`);
    return;
  }

  const lines = stale
    .slice(0, 20)
    .map((t) => `• <#${t.threadId}> — aberto ${time(new Date(t.openedAt), TimestampStyles.RelativeTime)} · ${t.status === 'waiting' ? '⏳ aguardando info' : '🔎 em triagem'}`);
  if (stale.length > 20) lines.push(`…e mais ${stale.length - 20}. Use \`/triagem pendentes\`.`);

  const roles = ctx.config.DISCORD_TRIAGE_ROLE_IDS.map((r) => `<@&${r}>`).join(' ');
  await channel.send({
    content: roles || undefined,
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.warn)
        .setTitle(`⏰ ${stale.length} tópico(s) de N2/N3 sem destino há mais de ${hours}h`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Nenhum N2/N3 termina sem um destino: card, resolvido ou não procede.' }),
    ],
  });
  ctx.store.markReminded(stale.map((t) => t.threadId));
}

/** Loop de sincronização Goalfy → Discord. Retorna função para parar. */
export function startSync(ctx: BotContext): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const links = ctx.store.openLinks();
      logger.debug(`Sincronizando ${links.length} card(s)`);
      for (const link of links) {
        await syncCard(ctx, link.cardId).catch((e) =>
          logger.warn(`Falha ao sincronizar card ${link.cardId}`, e instanceof GoalfyError ? e.message : e),
        );
        await new Promise((r) => setTimeout(r, 300)); // gentil com a API
      }
      await remindStaleTopics(ctx).catch((e) => logger.warn('Falha ao lembrar tópicos parados', e));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, ctx.config.SYNC_INTERVAL_SECONDS * 1000);
  void tick();
  return () => clearInterval(timer);
}
