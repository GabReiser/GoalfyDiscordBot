import {
  type AnyThreadChannel,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type Message,
  MessageFlags,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { BotContext } from '../context.js';
import type { NewCardInput } from '../goalfy/cards.js';
import type { Card } from '../goalfy/types.js';
import { logger } from '../logger.js';
import { choiceLabel, FRONTS, matchChoice, ORIGINS, SEVERITIES, TOPIC_STATUS, TYPES, typeFront } from '../process.js';
import { missingSections, parseTopic, type ParsedTopic, TEMPLATE_HINT } from '../topicTemplate.js';
import { primeComments } from './sync.js';
import { applyPhaseTag, closeThread, forumTagNames, isMonitoredForum, requireTriage, setTopicStatus } from './topics.js';
import {
  cardActions,
  cardEmbed,
  cardModal,
  type Classification,
  type ClassifyField,
  classifyMessage,
  COLORS,
  errorEmbed,
  infoEmbed,
  linkModal,
  okEmbed,
  rejectModal,
  resolveModal,
  triagePanel,
  truncate,
  waitingModal,
} from './ui.js';

// ── Contexto do tópico ──────────────────────────────────────────────────────

interface TopicContext {
  message?: Message;
  parsed: ParsedTopic;
  content: string;
  hasAttachments: boolean;
}

/** A mensagem inicial do tópico pode demorar alguns instantes para existir. */
async function starterMessage(thread: AnyThreadChannel, attempts: number): Promise<Message | undefined> {
  for (let i = 0; i < attempts; i++) {
    try {
      return (await thread.fetchStarterMessage()) ?? undefined;
    } catch {
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 750 * (i + 1)));
    }
  }
  return undefined;
}

/** Em interações use 1 tentativa: o Discord exige resposta em até 3s. */
async function topicContext(thread: AnyThreadChannel | undefined, attempts = 1): Promise<TopicContext> {
  const message = thread && (await starterMessage(thread, attempts));
  const content = message?.content ?? '';
  return { message, content, parsed: parseTopic(content), hasAttachments: (message?.attachments.size ?? 0) > 0 };
}

const threadOf = (i: { channel: unknown }) => {
  const ch = i.channel as { isThread?: () => boolean } | null;
  return ch?.isThread?.() ? (ch as AnyThreadChannel) : undefined;
};

/** Busca cards com palavras parecidas com o título (verificar duplicidade — seção 5.2). */
async function similarCards(ctx: BotContext, title: string): Promise<Card[]> {
  const words = [...new Set(title.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  const hits = new Map<string, { card: Card; score: number }>();
  for (const search of words) {
    try {
      for (const card of (await ctx.board.searchCards({ search, limit: 5 })).cards) {
        const prev = hits.get(card.id);
        hits.set(card.id, { card, score: (prev?.score ?? 0) + 1 });
      }
    } catch (e) {
      logger.debug(`Busca de cards parecidos falhou para "${search}"`, e);
    }
  }
  return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, 5).map((h) => h.card);
}

// ── Tópico novo ─────────────────────────────────────────────────────────────

export async function postTriagePanel(ctx: BotContext, thread: AnyThreadChannel, attempts = 1) {
  const { parsed, hasAttachments } = await topicContext(thread, attempts);
  const missing = missingSections(parsed, hasAttachments);
  const similar = await similarCards(ctx, thread.name);

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`${TOPIC_STATUS.triage.emoji} Em triagem`)
    .setDescription(
      `Obrigado por abrir o tópico${thread.ownerId ? `, <@${thread.ownerId}>` : ''}! A triagem N2/N3 vai analisar e dar um destino: ` +
        '**card na Goalfy**, **resolução direta** ou **encerramento**.\n' +
        'Você não precisa definir frente, prioridade ou prazo — só ajudar com o contexto. 🙏',
    )
    .setFooter({ text: 'Os botões abaixo são da equipe de triagem N2/N3' });

  if (missing.length) {
    embed.addFields({
      name: '📝 Consegue complementar?',
      value: truncate(`${missing.map((m) => `• ${m}`).join('\n')}\n\n_Isso ajuda a reproduzir o problema mais rápido._`, 1024),
    });
  }
  if (similar.length) {
    embed.addFields({
      name: '👯 Cards parecidos no board',
      value: truncate(similar.map((c) => `• [#${c.id} · ${truncate(c.title, 60)}](${ctx.board.cardUrl(c.id)})${c.phaseName ? ` — _${c.phaseName}_` : ''}`).join('\n'), 1024),
    });
  }

  await thread.send({ embeds: [embed], components: triagePanel() });
}

export async function onThreadCreate(ctx: BotContext, thread: AnyThreadChannel, newlyCreated: boolean) {
  if (!newlyCreated || !isMonitoredForum(ctx, thread) || ctx.store.topic(thread.id)) return;
  ctx.store.openTopic(thread.id, thread.ownerId ?? '', thread.name);
  await setTopicStatus(ctx, thread, 'triage');
  await postTriagePanel(ctx, thread, 4).catch((e) => logger.error(`Falha ao postar painel no tópico ${thread.id}`, e));
}

/** Solicitante respondeu um tópico "Aguardando informação" → volta para triagem. */
export async function onThreadMessage(ctx: BotContext, message: Message) {
  if (message.author.bot || !message.channel.isThread()) return;
  const topic = ctx.store.topic(message.channel.id);
  if (topic?.status !== 'waiting' || message.author.id !== topic.ownerId) return;
  await setTopicStatus(ctx, message.channel, 'triage');
  await message.react(TOPIC_STATUS.triage.emoji).catch(() => {});
}

// ── Criar card: passo 1 (classificação) ─────────────────────────────────────

const DRAFT_TTL_MS = 30 * 60_000;
const drafts = new Map<string, { c: Classification; at: number }>();
const draftKey = (userId: string, channelId: string | null) => `${userId}:${channelId}`;

function getDraft(userId: string, channelId: string | null): Classification | undefined {
  const d = drafts.get(draftKey(userId, channelId));
  return d && Date.now() - d.at < DRAFT_TTL_MS ? d.c : undefined;
}

function setDraft(userId: string, channelId: string | null, c: Classification) {
  drafts.set(draftKey(userId, channelId), { c, at: Date.now() });
  for (const [k, v] of drafts) if (Date.now() - v.at > DRAFT_TTL_MS) drafts.delete(k);
}

async function alreadyLinked(ctx: BotContext, interaction: ButtonInteraction | ChatInputCommandInteraction, thread?: AnyThreadChannel) {
  const linked = thread && ctx.store.byThread(thread.id);
  if (!linked) return false;
  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: `Este tópico já está vinculado ao card [#${linked.cardId}](${ctx.board.cardUrl(linked.cardId)}).`,
  });
  return true;
}

export async function startCardFlow(ctx: BotContext, interaction: ButtonInteraction | ChatInputCommandInteraction) {
  if (!(await requireTriage(ctx, interaction))) return;
  const thread = threadOf(interaction);
  if (await alreadyLinked(ctx, interaction, thread)) return;

  const { parsed } = await topicContext(thread);
  const tags = thread ? forumTagNames(thread) : [];
  const type = tags.map((t) => matchChoice(TYPES, t)).find(Boolean)?.value;
  const draft: Classification = {
    type,
    front: typeFront(type),
    origin: matchChoice(ORIGINS, parsed.origin)?.value,
  };
  setDraft(interaction.user.id, interaction.channelId, draft);
  await interaction.reply({ flags: MessageFlags.Ephemeral, ...classifyMessage(draft) });
}

export async function onClassifySelect(interaction: StringSelectMenuInteraction, field: ClassifyField) {
  const c = { ...(getDraft(interaction.user.id, interaction.channelId) ?? {}) };
  const value = interaction.values[0];
  c[field] = value;
  if (field === 'type') {
    c.front = typeFront(value) ?? c.front;
    if (!['Bug', 'Regressão'].includes(value ?? '') && !c.severity) c.severity = 'N/A';
  }
  setDraft(interaction.user.id, interaction.channelId, c);
  await interaction.update(classifyMessage(c));
}

export async function onClassifyNext(ctx: BotContext, interaction: ButtonInteraction) {
  const c = getDraft(interaction.user.id, interaction.channelId) ?? {};
  const missing = [!c.type && 'Tipo', !c.front && 'Frente', !c.origin && 'Origem', !c.severity && 'Severidade'].filter(Boolean);
  if (missing.length) {
    await interaction.update(classifyMessage(c, `Falta escolher: ${missing.join(', ')}.`));
    return;
  }

  const thread = threadOf(interaction);
  const { parsed, content, message } = await topicContext(thread);
  const attachments = message ? [...message.attachments.values()].map((a) => `📎 ${a.name}: ${a.url}`) : [];
  await interaction.showModal(
    cardModal({
      title: thread?.name ?? '',
      description: [content, ...attachments].filter(Boolean).join('\n\n'),
      expectedResult: parsed.expected ?? '',
      client: parsed.client ?? '',
      ticketLink: content.match(/https?:\/\/\S*(?:ticket|chamado|suporte|helpdesk|zendesk|freshdesk)\S*/i)?.[0] ?? '',
    }),
  );
}

export async function onClassifyCancel(interaction: ButtonInteraction) {
  drafts.delete(draftKey(interaction.user.id, interaction.channelId));
  await interaction.update({ content: 'Criação de card cancelada.', embeds: [], components: [] });
}

// ── Criar card: passo 2 (modal) ─────────────────────────────────────────────

async function announceLinkedCard(ctx: BotContext, thread: AnyThreadChannel, card: Card, userId: string, extra?: string) {
  const embed = cardEmbed(ctx.board, card, await ctx.board.phaseOf(card)).setDescription(
    [
      `${TOPIC_STATUS.card.emoji} **Card criado** por <@${userId}> — a demanda está registrada na Goalfy.`,
      extra,
      '_Criar o card não significa prazo de entrega: a priorização é feita por Produto/Tecnologia._',
      'Mudanças de fase e comentários dos devs vão aparecer aqui.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  const msg = await thread.send({ embeds: [embed], components: [cardActions(ctx.board, card.id)] });
  await msg.pin().catch(() => {});
}

async function linkThread(ctx: BotContext, thread: AnyThreadChannel, card: Card, userId: string) {
  const phase = await ctx.board.phaseOf(card);
  ctx.store.link({
    threadId: thread.id,
    cardId: card.id,
    channelId: thread.parentId ?? thread.id,
    createdBy: ctx.store.topic(thread.id)?.ownerId || thread.ownerId || userId,
    phaseId: phase?.id ?? card.phaseId ?? null,
    phaseName: phase?.title ?? card.phaseName ?? null,
  });
  await primeComments(ctx, card.id);
  await setTopicStatus(ctx, thread, 'card');
  await applyPhaseTag(ctx, thread, phase);
}

export async function onCreateModal(ctx: BotContext, interaction: ModalSubmitInteraction) {
  const c = getDraft(interaction.user.id, interaction.channelId);
  if (!c?.type || !c.front || !c.origin) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'A classificação expirou. Clique em **Criar card** de novo.' });
    return;
  }
  const thread = threadOf(interaction);
  if (thread && ctx.store.byThread(thread.id)) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Alguém já criou um card para este tópico. 🙂' });
    return;
  }

  if (interaction.isFromMessage()) await interaction.update({ embeds: [infoEmbed('⏳ Criando card na Goalfy…')], components: [] });
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const member = interaction.inCachedGuild() ? interaction.member : undefined;
  const ownerId = thread && (ctx.store.topic(thread.id)?.ownerId || thread.ownerId);
  const owner = ownerId ? await interaction.guild?.members.fetch(ownerId).catch(() => undefined) : undefined;
  const input: NewCardInput = {
    title: interaction.fields.getTextInputValue('title').trim(),
    description: interaction.fields.getTextInputValue('description').trim(),
    expectedResult: interaction.fields.getTextInputValue('expectedResult').trim() || undefined,
    client: interaction.fields.getTextInputValue('client').trim() || undefined,
    ticketLink: interaction.fields.getTextInputValue('ticketLink').trim() || undefined,
    front: c.front,
    type: c.type,
    origin: c.origin,
    severity: c.severity,
    discordLink: thread?.url,
    requester: owner?.displayName ?? member?.displayName ?? interaction.user.username,
  };

  try {
    const card = await ctx.cards.create(input);
    drafts.delete(draftKey(interaction.user.id, interaction.channelId));
    const summary = `${choiceLabel(TYPES, c.type)} · ${choiceLabel(FRONTS, c.front)} · ${choiceLabel(ORIGINS, c.origin)}` +
      (c.severity && c.severity !== 'N/A' ? ` · ${choiceLabel(SEVERITIES, c.severity)}` : '');

    if (thread) {
      await linkThread(ctx, thread, card, interaction.user.id);
      ctx.store.classify(thread.id, { front: c.front, type: c.type, origin: c.origin, severity: c.severity });
      await announceLinkedCard(ctx, thread, card, interaction.user.id, summary);
      await interaction.editReply({ embeds: [okEmbed(`Card [#${card.id}](${ctx.board.cardUrl(card.id)}) criado e vinculado ao tópico.`)] });
    } else {
      await interaction.editReply({
        embeds: [cardEmbed(ctx.board, card, await ctx.board.phaseOf(card)).setDescription(summary)],
        components: [cardActions(ctx.board, card.id)],
      });
    }
    logger.info(`Card #${card.id} criado por ${interaction.user.tag}${thread ? ` (tópico ${thread.id})` : ''}`);
  } catch (e) {
    logger.error('Falha ao criar card', e);
    await interaction.editReply({ embeds: [errorEmbed(e)], components: [] });
  }
}

// ── Vincular card existente ─────────────────────────────────────────────────

/** Aceita "123", "#123" ou a URL do card. */
export function parseCardRef(ref: string): string | undefined {
  const s = ref.trim();
  return s.match(/\/card\/([\w-]+)/)?.[1] ?? s.match(/^#?([\w-]+)$/)?.[1];
}

export async function linkExistingCard(ctx: BotContext, thread: AnyThreadChannel, ref: string, userId: string): Promise<string> {
  const cardId = parseCardRef(ref);
  if (!cardId) throw new Error('Não entendi o card. Informe o ID (ex.: 12345) ou o link.');
  if (ctx.store.byThread(thread.id)) throw new Error('Este tópico já está vinculado a um card.');
  const other = ctx.store.byCard(cardId);
  if (other) throw new Error(`O card #${cardId} já está vinculado ao tópico <#${other.threadId}>.`);

  const card = await ctx.cards.get(cardId);
  await linkThread(ctx, thread, card, userId);
  await ctx.cards.comment(card.id, `Tópico do Discord vinculado: ${thread.url}`).catch(() => {});
  await announceLinkedCard(ctx, thread, card, userId, '🔗 Ocorrência vinculada a um card que já existia.');
  return card.id;
}

export async function onLinkButton(ctx: BotContext, interaction: ButtonInteraction) {
  if (!(await requireTriage(ctx, interaction))) return;
  if (await alreadyLinked(ctx, interaction, threadOf(interaction))) return;
  await interaction.showModal(linkModal());
}

export async function onLinkModal(ctx: BotContext, interaction: ModalSubmitInteraction) {
  const thread = threadOf(interaction);
  if (!thread) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const id = await linkExistingCard(ctx, thread, interaction.fields.getTextInputValue('card'), interaction.user.id);
    await interaction.editReply({ embeds: [okEmbed(`Tópico vinculado ao card #${id}.`)] });
  } catch (e) {
    await interaction.editReply({ embeds: [errorEmbed(e)] });
  }
}

// ── Aguardando informação / Resolvido / Não procede ─────────────────────────

export async function onWaitingButton(ctx: BotContext, interaction: ButtonInteraction) {
  if (!(await requireTriage(ctx, interaction))) return;
  const thread = threadOf(interaction);
  const { parsed, hasAttachments } = await topicContext(thread);
  await interaction.showModal(waitingModal(missingSections(parsed, hasAttachments)));
}

export async function onWaitingModal(ctx: BotContext, interaction: ModalSubmitInteraction) {
  const thread = threadOf(interaction);
  if (!thread) return;
  const ownerId = ctx.store.topic(thread.id)?.ownerId || thread.ownerId;
  await interaction.reply({
    content: ownerId ? `<@${ownerId}>` : undefined,
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.warn)
        .setTitle(`${TOPIC_STATUS.waiting.emoji} Aguardando informação`)
        .setDescription(interaction.fields.getTextInputValue('message'))
        .addFields({ name: 'Modelo de abertura', value: TEMPLATE_HINT })
        .setFooter({ text: `Pedido por ${interaction.user.displayName} · responda aqui mesmo no tópico` }),
    ],
  });
  await setTopicStatus(ctx, thread, 'waiting');
}

export async function onResolveButton(ctx: BotContext, interaction: ButtonInteraction) {
  if (!(await requireTriage(ctx, interaction))) return;
  await interaction.showModal(resolveModal());
}

export async function onResolveModal(ctx: BotContext, interaction: ModalSubmitInteraction) {
  const thread = threadOf(interaction);
  if (!thread) return;
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.done)
        .setTitle(`${TOPIC_STATUS.resolved.emoji} Resolvido na triagem`)
        .setDescription(interaction.fields.getTextInputValue('message'))
        .setFooter({ text: `Por ${interaction.user.displayName} · se voltar a acontecer, responda aqui` }),
    ],
  });
  await setTopicStatus(ctx, thread, 'resolved');
  await closeThread(thread, 'Resolvido na triagem');
}

export async function onRejectButton(ctx: BotContext, interaction: ButtonInteraction) {
  if (!(await requireTriage(ctx, interaction))) return;
  await interaction.showModal(rejectModal());
}

export async function onRejectModal(ctx: BotContext, interaction: ModalSubmitInteraction) {
  const thread = threadOf(interaction);
  if (!thread) return;
  const reason = interaction.fields.getStringSelectValues('reason')[0] ?? 'Outro';
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.muted)
        .setTitle(`${TOPIC_STATUS.rejected.emoji} Não procede — ${reason}`)
        .setDescription(interaction.fields.getTextInputValue('message'))
        .setFooter({ text: `Por ${interaction.user.displayName}` }),
    ],
  });
  await setTopicStatus(ctx, thread, 'rejected');
  await closeThread(thread, `Não procede: ${reason}`);
}
