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
import { InvalidFieldValuesError } from '../goalfy/cards.js';
import { type CreatePlan, matchOption, planCreate, RESPONSIBLE_FIELD_ID } from '../goalfy/formPlan.js';
import type { Card, FormField } from '../goalfy/types.js';
import { logger } from '../logger.js';
import { FIELD_ALIASES, type LogicalField, normalize, SEVERITY_TAGS, TOPIC_STATUS, typeFront } from '../process.js';
import { missingSections, parseTopic, type ParsedTopic, TEMPLATE_HINT } from '../topicTemplate.js';
import { primeComments } from './sync.js';
import { applyPhaseTag, closeThread, forumTagNames, isMonitoredForum, requireTriage, setTopicStatus } from './topics.js';
import {
  cardActions,
  cardEmbed,
  cardModal,
  classifyModal,
  draftMessage,
  COLORS,
  errorEmbed,
  type FormValues,
  infoEmbed,
  linkModal,
  okEmbed,
  readModalValues,
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
//
// Os campos vêm do Formulário Inicial do board (planCreate): selects no passo 1,
// textos no modal do passo 2. O rascunho fica em memória entre os passos.

interface CreateDraft {
  plan: CreatePlan;
  values: FormValues;
  /** Selects alterados pelo usuário (a sugestão automática não sobrescreve). */
  touched: Set<string>;
  title: string;
  /** Rótulo do select "Responsável" → e-mail do membro na Goalfy. */
  responsibleEmails?: Map<string, string>;
  at: number;
}

const DRAFT_TTL_MS = 30 * 60_000;
const drafts = new Map<string, CreateDraft>();
const draftKey = (userId: string, channelId: string | null) => `${userId}:${channelId}`;

function getDraft(userId: string, channelId: string | null): CreateDraft | undefined {
  const d = drafts.get(draftKey(userId, channelId));
  return d && Date.now() - d.at < DRAFT_TTL_MS ? d : undefined;
}

function saveDraft(userId: string, channelId: string | null, d: CreateDraft) {
  drafts.set(draftKey(userId, channelId), { ...d, at: Date.now() });
  for (const [k, v] of drafts) if (Date.now() - v.at > DRAFT_TTL_MS) drafts.delete(k);
}

const hasAlias = (f: FormField, key: LogicalField) => {
  const n = normalize(f.name);
  return FIELD_ALIASES[key].some((a) => n === a || n.includes(a));
};

/** Frente sugerida pelo tipo (tabela de classificação do processo), se o usuário não escolheu outra. */
function suggestFront(fields: FormField[], values: FormValues, touched: Set<string>) {
  const typeField = fields.find((f) => hasAlias(f, 'type'));
  const frontField = fields.find((f) => hasAlias(f, 'front'));
  if (!typeField || !frontField || touched.has(frontField.fieldInfoId)) return;
  const front = typeFront(values[typeField.fieldInfoId]?.[0]);
  const option = front && matchOption(frontField, front);
  if (option) values[frontField.fieldInfoId] = [option];
}

/**
 * Pré-seleção a partir do tópico:
 *  - tags do fórum com o mesmo nome de uma opção (ex.: "Major" → Prioridade especial, "Regressão" → Tipo);
 *  - SEVERITY_TAGS (ex.: tag "Major" → "S1 — Crítico" num campo de severidade);
 *  - "Origem: …" escrito no modelo de abertura.
 */
export function suggestSelects(fields: FormField[], tags: string[], parsed: ParsedTopic): FormValues {
  const values: FormValues = {};
  const normTags = tags.map(normalize);
  const severityHints = normTags.map((t) => SEVERITY_TAGS[t]).filter((s): s is string => !!s);
  for (const f of fields) {
    const byTag = f.options.find((o) => normTags.includes(normalize(o)));
    const fuzzy = [...severityHints, ...(hasAlias(f, 'origin') && parsed.origin ? [parsed.origin] : [])]
      .map((h) => matchOption(f, h))
      .find(Boolean);
    const hit = byTag ?? fuzzy;
    if (hit) values[f.fieldInfoId] = [hit];
  }
  suggestFront(fields, values, new Set());
  return values;
}

/** Texto inicial dos campos do modal, tirado do tópico. */
export function suggestTexts(
  ctx: { description?: FormField },
  fields: FormField[],
  topic: Pick<TopicContext, 'content' | 'parsed' | 'message'>,
): FormValues {
  const values: FormValues = {};
  const attachments = topic.message ? [...topic.message.attachments.values()].map((a) => `📎 ${a.name}: ${a.url}`) : [];
  const ticket = topic.content.match(/https?:\/\/\S*(?:ticket|chamado|suporte|helpdesk|zendesk|freshdesk)\S*/i)?.[0];
  const email = topic.content.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
  const firstLine = (s: string | undefined) => s?.split(/\r?\n/).find((l) => l.trim())?.trim();
  for (const f of fields) {
    let v: string | undefined;
    if (f === ctx.description) v = [topic.content, ...attachments].filter(Boolean).join('\n\n');
    else if (/email/.test(f.type) || normalize(f.name).includes('e mail')) v = email;
    else if (hasAlias(f, 'expectedResult')) v = topic.parsed.expected;
    else if (hasAlias(f, 'client')) v = firstLine(topic.parsed.client);
    else if (hasAlias(f, 'ticketLink')) v = ticket;
    if (v) values[f.fieldInfoId] = [v];
  }
  return values;
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

function planWarning(plan: CreatePlan): string | undefined {
  if (!plan.missingRequired.length) return undefined;
  return `O formulário tem obrigatórios que o bot não consegue preencher (${plan.missingRequired.map((f) => f.name).join(', ')}). A Goalfy pode recusar o card.`;
}

/** Monta o rascunho: plano do formulário + sugestões tiradas do tópico. */
async function prepareDraft(ctx: BotContext, thread: AnyThreadChannel | undefined): Promise<CreateDraft> {
  const form = await ctx.board.createForm();
  // Sem os membros (API fora), o card ainda pode ser criado: só some o campo "Responsável".
  const responsible = await ctx.board.responsibleField().catch((e) => {
    logger.warn('Não consegui listar os membros do board para o campo Responsável', e);
    return undefined;
  });
  const plan = planCreate(form, responsible?.field);
  const topic = await topicContext(thread);
  const values = {
    ...suggestSelects(plan.selects, thread ? forumTagNames(thread) : [], topic.parsed),
    ...suggestTexts({ description: form.fields.description }, plan.modal, topic),
  };
  return { plan, values, touched: new Set(), title: thread?.name ?? '', responsibleEmails: responsible?.emailByLabel, at: Date.now() };
}

/**
 * Tempo máximo para preparar o rascunho e abrir o modal direto no clique. O Discord exige
 * resposta em 3s; passando disso, o bot responde com o botão "Preencher" (fallback).
 */
const MODAL_BUDGET_MS = 2000;

/**
 * Criar card, em dois modais (seleções num modal ficam na tela da pessoa, sem ida e volta
 * ao Discord a cada escolha — em mensagem, cada select travava o formulário):
 *   1. título + selects (Origem, Tipo…), já pré-selecionados pelo tópico
 *   2. campos de texto (Descrição, links…)
 */
export async function startCardFlow(ctx: BotContext, interaction: ButtonInteraction | ChatInputCommandInteraction) {
  if (!(await requireTriage(ctx, interaction))) return;
  const thread = threadOf(interaction);
  if (await alreadyLinked(ctx, interaction, thread)) return;

  const prep = prepareDraft(ctx, thread);
  const ready = await Promise.race([
    prep.then(
      (d) => d,
      () => null,
    ),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), MODAL_BUDGET_MS)),
  ]);
  if (ready) {
    saveDraft(interaction.user.id, interaction.channelId, ready);
    await interaction.showModal(classifyModal(ready.title, ready.plan.selects, ready.values));
    return;
  }

  // Lento (ou falhou): responde já e oferece o botão para abrir o formulário quando estiver pronto.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const d = await prep;
    saveDraft(interaction.user.id, interaction.channelId, d);
    await interaction.editReply(draftMessage(d.plan.selects, d.values, 'open', planWarning(d.plan)));
  } catch (e) {
    logger.error('Falha ao montar o formulário de criação', e);
    await interaction.editReply({ embeds: [errorEmbed(e)] });
  }
}

const expired = { content: 'O formulário expirou. Clique em **Criar card** de novo.', embeds: [], components: [] };

/** Botão "Preencher"/"Alterar classificação": reabre o modal 1 com o que já foi escolhido. */
export async function onClassifyOpen(interaction: ButtonInteraction) {
  const d = getDraft(interaction.user.id, interaction.channelId);
  if (!d) return void (await interaction.update(expired));
  await interaction.showModal(classifyModal(d.title, d.plan.selects, d.values));
}

/** Selects da versão antiga (mensagem efêmera): o fluxo agora é por modal. */
export async function onLegacyClassifySelect(interaction: StringSelectMenuInteraction) {
  await interaction.update(expired);
}

/** Envio do modal 1 (título + classificação). */
export async function onClassifyModal(ctx: BotContext, interaction: ModalSubmitInteraction) {
  const d = getDraft(interaction.user.id, interaction.channelId);
  if (!d) return void (await interaction.reply({ flags: MessageFlags.Ephemeral, ...expired }));

  d.title = interaction.fields.getTextInputValue('title').trim();
  Object.assign(d.values, readModalValues(interaction, d.plan.selects));
  for (const f of d.plan.selects) d.touched.add(f.fieldInfoId);
  saveDraft(interaction.user.id, interaction.channelId, d);

  // Formulário sem campos de texto: não há passo 2, cria direto.
  if (!d.plan.modal.length) return createFromDraft(ctx, interaction, d);

  const message = draftMessage(d.plan.selects, d.values, 'classified', planWarning(d.plan));
  if (interaction.isFromMessage()) await interaction.update(message);
  else await interaction.reply({ flags: MessageFlags.Ephemeral, ...message });
}

/** Botão "Continuar": abre o modal 2 (textos), já com o que foi digitado antes, se houver. */
export async function onClassifyNext(_ctx: BotContext, interaction: ButtonInteraction) {
  const d = getDraft(interaction.user.id, interaction.channelId);
  if (!d) return void (await interaction.update(expired));
  await interaction.showModal(cardModal(d.plan.modal, d.values));
}

export async function onClassifyCancel(interaction: ButtonInteraction) {
  drafts.delete(draftKey(interaction.user.id, interaction.channelId));
  await interaction.update({ content: 'Criação de card cancelada.', embeds: [], components: [] });
}

// ── Criar card: passo 2 (modal) ─────────────────────────────────────────────

async function announceLinkedCard(ctx: BotContext, thread: AnyThreadChannel, card: Card, userId: string, extra?: string) {
  const embed = cardEmbed(ctx.board, card, await ctx.board.phaseOf(card)).setDescription(
    [
      `${TOPIC_STATUS.card.emoji} **Card criado** por <@${userId}>: a demanda está registrada na Goalfy.`,
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

/** Envio do modal 2 (textos). */
export async function onCreateModal(ctx: BotContext, interaction: ModalSubmitInteraction) {
  const d = getDraft(interaction.user.id, interaction.channelId);
  if (!d) return void (await interaction.reply({ flags: MessageFlags.Ephemeral, ...expired }));
  // Guarda o que foi digitado: se algo for recusado, o modal reabre preenchido.
  Object.assign(d.values, readModalValues(interaction, d.plan.modal));
  saveDraft(interaction.user.id, interaction.channelId, d);
  await createFromDraft(ctx, interaction, d);
}

async function createFromDraft(ctx: BotContext, interaction: ModalSubmitInteraction, d: CreateDraft) {
  const thread = threadOf(interaction);
  if (thread && ctx.store.byThread(thread.id)) {
    const msg = { content: 'Alguém já criou um card para este tópico. 🙂', embeds: [], components: [] };
    if (interaction.isFromMessage()) await interaction.update(msg);
    else await interaction.reply({ flags: MessageFlags.Ephemeral, ...msg });
    return;
  }

  if (interaction.isFromMessage()) await interaction.update({ embeds: [infoEmbed('⏳ Criando card na Goalfy…')], components: [] });
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const member = interaction.inCachedGuild() ? interaction.member : undefined;
  const ownerId = thread && (ctx.store.topic(thread.id)?.ownerId || thread.ownerId);
  const owner = ownerId ? await interaction.guild?.members.fetch(ownerId).catch(() => undefined) : undefined;

  try {
    const card = await ctx.cards.create({
      title: d.title,
      values: d.values,
      requester: owner?.displayName ?? member?.displayName ?? interaction.user.username,
      discordUrl: thread?.url,
    });
    drafts.delete(draftKey(interaction.user.id, interaction.channelId));

    // Responsável escolhido no modal 2 (campo virtual): vai por addResponsible, com o e-mail do membro.
    const responsibleLabel = d.values[RESPONSIBLE_FIELD_ID]?.[0];
    const responsibleEmail = responsibleLabel ? d.responsibleEmails?.get(responsibleLabel) : undefined;
    let responsibleNote = '';
    if (responsibleEmail) {
      try {
        await ctx.cards.addResponsible(card.id, responsibleEmail);
        Object.assign(card, await ctx.cards.get(card.id).catch(() => card)); // embed já com o responsável
      } catch (e) {
        logger.warn(`Card #${card.id} criado, mas não consegui definir o responsável`, e);
        responsibleNote = `⚠️ Não consegui definir **${responsibleLabel}** como responsável; defina na Goalfy.`;
      }
    }

    const classification = Object.fromEntries(
      d.plan.selects.filter((f) => d.values[f.fieldInfoId]?.length).map((f) => [f.name, d.values[f.fieldInfoId]!.join(', ')]),
    );
    const summary = [
      Object.entries(classification)
        .map(([k, v]) => `**${k}:** ${v}`)
        .join(' · '),
      responsibleLabel && !responsibleNote ? `👤 **Responsável:** ${responsibleLabel}` : '',
      responsibleNote,
    ]
      .filter(Boolean)
      .join('\n');

    if (thread) {
      await linkThread(ctx, thread, card, interaction.user.id);
      ctx.store.classify(thread.id, classification);
      await announceLinkedCard(ctx, thread, card, interaction.user.id, summary);
      await interaction.editReply({
        embeds: [okEmbed(`Card [#${card.id}](${ctx.board.cardUrl(card.id)}) criado e vinculado ao tópico.`)],
        components: [],
      });
    } else {
      await interaction.editReply({
        embeds: [cardEmbed(ctx.board, card, await ctx.board.phaseOf(card)).setDescription(summary || null)],
        components: [cardActions(ctx.board, card.id)],
      });
    }
    logger.info(`Card #${card.id} criado por ${interaction.user.tag}${thread ? ` (tópico ${thread.id})` : ''}`);
  } catch (e) {
    if (e instanceof InvalidFieldValuesError) {
      // Mostra o motivo com os botões para corrigir; os modais reabrem com o que já foi preenchido.
      await interaction.editReply(draftMessage(d.plan.selects, d.values, 'classified', e.problems.join(' ')));
      return;
    }
    logger.error('Falha ao criar card', e);
    await interaction.editReply({ embeds: [errorEmbed(e)], components: [] });
  }
}

// ── Vincular card existente ─────────────────────────────────────────────────

/** Aceita "123", "#123" ou a URL do card. */
export function parseCardRef(ref: string): string | undefined {
  const s = ref.trim();
  // Aceita o link do front (/board/{board}/cards/{card}), o formato antigo (/card/{card}), "#id" ou o id.
  return s.match(/\/cards?\/([\w-]+)/)?.[1] ?? s.match(/^#?([\w-]+)$/)?.[1];
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
