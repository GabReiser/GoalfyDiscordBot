import {
  ApplicationCommandType,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  type MessageContextMenuCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type StringSelectMenuInteraction,
  time,
  TimestampStyles,
} from 'discord.js';
import type { BotContext } from '../context.js';
import { type Card, type FormField, toCards } from '../goalfy/types.js';
import { logger } from '../logger.js';
import { normalize, TOPIC_STATUS } from '../process.js';
import { requestMove } from './move.js';
import { linkExistingCard, parseCardRef, postTriagePanel, startCardFlow } from './triage.js';
import { planCreate } from '../goalfy/formPlan.js';
import { checkDiscordSetup } from './setup.js';
import { isMonitoredForum, requireTriage } from './topics.js';
import {
  cardActions,
  cardEmbed,
  cardPicker,
  COLORS,
  errorEmbed,
  listPager,
  okEmbed,
  phaseSelect,
  truncate,
} from './ui.js';

const PAGE_SIZE = 10;

// ── Definições ──────────────────────────────────────────────────────────────

const cardOption = (required: boolean) => (o: import('discord.js').SlashCommandStringOption) =>
  o
    .setName('card')
    .setDescription(required ? 'ID, link ou busca pelo título' : 'ID, link ou busca (padrão: card deste tópico)')
    .setAutocomplete(true)
    .setRequired(required);

const cardCommand = new SlashCommandBuilder()
  .setName('card')
  .setDescription('Cards do board de backlog na Goalfy')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('criar').setDescription('Criar um card (triagem N2/N3)'))
  .addSubcommand((s) =>
    s
      .setName('listar')
      .setDescription('Listar cards do board')
      .addStringOption((o) => o.setName('fase').setDescription('Filtrar por fase').setAutocomplete(true))
      .addStringOption((o) => o.setName('busca').setDescription('Buscar pelo título'))
      .addBooleanOption((o) => o.setName('publico').setDescription('Mostrar para todos no canal')),
  )
  .addSubcommand((s) => s.setName('ver').setDescription('Ver detalhes de um card').addStringOption(cardOption(false)))
  .addSubcommand((s) =>
    s
      .setName('mover')
      .setDescription('Mover um card de fase')
      .addStringOption((o) => o.setName('fase').setDescription('Fase de destino').setAutocomplete(true).setRequired(true))
      .addStringOption(cardOption(false)),
  )
  .addSubcommand((s) =>
    s
      .setName('comentar')
      .setDescription('Comentar no card')
      .addStringOption((o) => o.setName('texto').setDescription('Comentário').setRequired(true).setMaxLength(2000))
      .addStringOption(cardOption(false)),
  )
  .addSubcommand((s) =>
    s.setName('vincular').setDescription('Vincular este tópico a um card que já existe').addStringOption(cardOption(true)),
  );

const triageCommand = new SlashCommandBuilder()
  .setName('triagem')
  .setDescription('Processo de N2/N3')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('pendentes').setDescription('Tópicos de N2/N3 ainda sem destino'))
  .addSubcommand((s) =>
    s
      .setName('relatorio')
      .setDescription('Indicadores do processo de N2/N3')
      .addIntegerOption((o) => o.setName('dias').setDescription('Período em dias (padrão: 7)').setMinValue(1).setMaxValue(365)),
  )
  .addSubcommand((s) => s.setName('painel').setDescription('Reenviar o painel de triagem neste tópico'));

const goalfyCommand = new SlashCommandBuilder()
  .setName('goalfy')
  .setDescription('Diagnóstico da integração com a Goalfy')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('status').setDescription('Board, fases e campos detectados'));

const sendToCardMenu = new ContextMenuCommandBuilder()
  .setName('Enviar ao card Goalfy')
  .setType(ApplicationCommandType.Message)
  .setContexts(InteractionContextType.Guild);

export const commandData = [cardCommand, triageCommand, goalfyCommand, sendToCardMenu].map((c) => c.toJSON());

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveCardId(ctx: BotContext, interaction: ChatInputCommandInteraction): string {
  const ref = interaction.options.getString('card');
  if (ref) {
    const id = parseCardRef(ref);
    if (!id) throw new Error('Não entendi o card informado.');
    return id;
  }
  const linked = ctx.store.byThread(interaction.channelId);
  if (!linked) throw new Error('Informe o card, ou use o comando dentro de um tópico vinculado.');
  return linked.cardId;
}

async function showCard(ctx: BotContext, cardId: string) {
  const card = await ctx.cards.get(cardId);
  const embed = cardEmbed(ctx.board, card, await ctx.board.phaseOf(card));
  const link = ctx.store.byCard(card.id);
  if (link) embed.setDescription(`💬 Tópico: <#${link.threadId}>`);
  return { embeds: [embed], components: [cardActions(ctx.board, card.id)] };
}

async function listPage(ctx: BotContext, page: number, phaseId?: string, search?: string) {
  let cards: Card[];
  let hasNext: boolean;
  const phase = phaseId ? await ctx.board.phase(phaseId) : undefined;

  if (phaseId) {
    // Endpoint por fase não pagina: filtra e fatia aqui.
    let all = await ctx.board.withPhaseNames(toCards(await ctx.goalfy.listCardsByPhase(phaseId)));
    if (search) all = all.filter((c) => normalize(c.title).includes(normalize(search)));
    cards = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    hasNext = all.length > page * PAGE_SIZE;
  } else {
    const result = await ctx.board.searchCards({ page, limit: PAGE_SIZE, search });
    cards = result.cards;
    hasNext = result.total !== undefined ? result.total > page * PAGE_SIZE : cards.length === PAGE_SIZE;
  }

  const scope = [phase ? `fase **${phase.title}**` : 'board inteiro', search ? `busca "${search}"` : ''].filter(Boolean).join(' · ');
  const lines = cards.map((c) => {
    const topic = ctx.store.byCard(c.id);
    const who = c.responsibles.length ? ` · 👤 ${c.responsibles.join(', ')}` : '';
    const where = phaseId ? '' : c.phaseName ? ` · _${c.phaseName}_` : '';
    return `**[#${c.id}](${ctx.board.cardUrl(c.id)})** ${truncate(c.title, 80)}${where}${who}${topic ? ` · <#${topic.threadId}>` : ''}`;
  });

  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('📋 Cards do backlog')
    .setURL(ctx.board.boardUrl())
    .setDescription(`${scope}\n\n${lines.join('\n') || '_Nenhum card encontrado._'}`);

  const components = [];
  if (cards.length) components.push(cardPicker(cards));
  if (page > 1 || hasNext) components.push(listPager(page, hasNext, phaseId, search));
  return { embeds: [embed], components };
}

// ── /card ───────────────────────────────────────────────────────────────────

async function handleCard(ctx: BotContext, interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'criar') return startCardFlow(ctx, interaction);

  if (sub === 'listar') {
    const publico = interaction.options.getBoolean('publico') ?? false;
    await interaction.deferReply({ flags: publico ? undefined : MessageFlags.Ephemeral });
    const phaseRef = interaction.options.getString('fase') ?? undefined;
    const phase = phaseRef ? await ctx.board.phase(phaseRef) : undefined;
    if (phaseRef && !phase) throw new Error('Fase não encontrada neste board.');
    await interaction.editReply(await listPage(ctx, 1, phase?.id, interaction.options.getString('busca') ?? undefined));
    return;
  }

  if (sub === 'ver') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await showCard(ctx, resolveCardId(ctx, interaction)));
    return;
  }

  if (sub === 'mover') {
    if (!(await requireTriage(ctx, interaction))) return;
    const cardId = resolveCardId(ctx, interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const fase = interaction.options.getString('fase', true);
    await interaction.editReply(await requestMove(ctx, interaction.user.id, cardId, fase, interaction.user.displayName));
    return;
  }

  if (sub === 'comentar') {
    const cardId = resolveCardId(ctx, interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await ctx.cards.comment(cardId, `${interaction.user.displayName}: ${interaction.options.getString('texto', true)}`);
    await interaction.editReply({ embeds: [okEmbed(`Comentário enviado ao card [#${cardId}](${ctx.board.cardUrl(cardId)}).`)] });
    return;
  }

  if (sub === 'vincular') {
    if (!(await requireTriage(ctx, interaction))) return;
    const thread = interaction.channel?.isThread() ? interaction.channel : undefined;
    if (!thread) throw new Error('Use este comando dentro do tópico que deve ser vinculado.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = await linkExistingCard(ctx, thread, interaction.options.getString('card', true), interaction.user.id);
    await interaction.editReply({ embeds: [okEmbed(`Tópico vinculado ao card #${id}.`)] });
  }
}

// ── /triagem ────────────────────────────────────────────────────────────────

function counts(title: string, data: Record<string, number>) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const value = entries.length ? entries.map(([k, v]) => `${k}: **${v}**`).join('\n') : '—';
  return { name: truncate(title, 256), value: truncate(value, 1024), inline: true };
}

async function handleTriage(ctx: BotContext, interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'pendentes') {
    const pending = ctx.store.pendingTopics();
    const lines = pending.slice(0, 30).map((t) => {
      const st = TOPIC_STATUS[t.status];
      return `${st.emoji} <#${t.threadId}> — aberto ${time(new Date(t.openedAt), TimestampStyles.RelativeTime)}`;
    });
    if (pending.length > 30) lines.push(`…e mais ${pending.length - 30}.`);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [
        new EmbedBuilder()
          .setColor(pending.length ? COLORS.warn : COLORS.done)
          .setTitle(`🔎 ${pending.length} tópico(s) sem destino`)
          .setDescription(lines.join('\n') || 'Nenhum N2/N3 sem destino. 🎉')
          .setFooter({ text: 'Destino = card criado, resolvido na triagem ou não procede' }),
      ],
    });
    return;
  }

  if (sub === 'relatorio') {
    const days = interaction.options.getInteger('dias') ?? 7;
    const since = new Date(Date.now() - days * 86_400_000);
    const r = ctx.store.report(since.toISOString());
    const avg = r.avgHoursToDestination === null ? '—' : r.avgHoursToDestination < 1 ? `${Math.round(r.avgHoursToDestination * 60)} min` : `${r.avgHoursToDestination.toFixed(1)} h`;
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.brand)
          .setTitle(`📊 N2/N3 — últimos ${days} dia(s)`)
          .setDescription(`Desde ${time(since, TimestampStyles.ShortDate)}`)
          .addFields(
            { name: 'Abertos', value: String(r.opened), inline: true },
            { name: 'Cards gerados', value: String(r.cards), inline: true },
            { name: 'Resolvidos na triagem', value: String(r.resolvedInTriage), inline: true },
            { name: 'Não procede', value: String(r.rejected), inline: true },
            { name: 'Sem destino', value: String(r.pending), inline: true },
            { name: 'Tempo médio até destino', value: avg, inline: true },
            ...Object.entries(r.byField)
              .slice(0, 12)
              .map(([field, data]) => counts(`Por ${field}`, data)),
          ),
      ],
    });
    return;
  }

  if (sub === 'painel') {
    if (!(await requireTriage(ctx, interaction))) return;
    const thread = interaction.channel?.isThread() ? interaction.channel : undefined;
    if (!thread) throw new Error('Use dentro de um tópico.');
    if (isMonitoredForum(ctx, thread)) ctx.store.openTopic(thread.id, thread.ownerId ?? '', thread.name);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await postTriagePanel(ctx, thread);
    await interaction.editReply({ embeds: [okEmbed('Painel enviado.')] });
  }
}

// ── /goalfy status ──────────────────────────────────────────────────────────

async function handleGoalfy(ctx: BotContext, interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  ctx.board.invalidate();
  const phases = await ctx.board.phases();
  const form = await ctx.board.createForm();
  const responsible = await ctx.board.responsibleField().catch(() => undefined);
  const plan = planCreate(form, responsible?.field);
  const name = (f: FormField) => `${f.name}${f.required ? ' *' : ''}`;
  const creation = [
    `**Modal 1:** Título do card *${plan.selects.length ? `, ${plan.selects.map(name).join(', ')}` : ''}`,
    `**Modal 2:** ${plan.modal.map(name).join(', ') || '— (cria direto após o modal 1)'}`,
    plan.auto.length ? `**Automático:** ${plan.auto.map((f) => f.name).join(', ')}` : '',
    plan.skipped.length ? `**Não perguntado:** ${plan.skipped.map((f) => f.name).join(', ')}` : '',
    plan.missingRequired.length ? `⚠️ **Obrigatórios que o bot não preenche:** ${plan.missingRequired.map((f) => f.name).join(', ')}` : '',
  ].filter(Boolean);
  const phaseRules: string[] = [];
  for (const p of phases) {
    const required = (await ctx.board.phaseFields(p).catch(() => [])).filter((f) => f.required);
    if (required.length) phaseRules.push(`**${p.title}** (${ctx.board.isDone(p) ? 'ao entrar' : 'antes de avançar'}): ${required.map((f) => f.name).join(', ')}`);
  }
  const setupProblems = await checkDiscordSetup(ctx);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.brand)
        .setTitle('⚙️ Integração Goalfy')
        .setURL(ctx.board.boardUrl())
        .addFields(
          { name: 'Board', value: `\`${ctx.board.boardId}\``, inline: true },
          { name: 'Formulário (modelId)', value: `\`${form.modelId}\``, inline: true },
          { name: 'Sincronização', value: `a cada ${ctx.config.SYNC_INTERVAL_SECONDS}s`, inline: true },
          {
            name: 'Fases',
            value: truncate(
              phases.map((p) => `${ctx.board.isCancel(p) ? '❌' : ctx.board.isDone(p) ? '✅' : '•'} ${p.title}`).join('\n') || '—',
              1024,
            ),
          },
          { name: 'Criação de card (* = obrigatório)', value: truncate(creation.join('\n'), 1024) },
          { name: 'Fases com campos obrigatórios', value: truncate(phaseRules.join('\n') || '—', 1024) },
          {
            name: 'Fases em que o card pode nascer',
            value: truncate((await ctx.board.creatablePhases()).map((p) => p.title).join(', ') || '—', 1024),
          },
          {
            name: 'Servidor do Discord',
            value: truncate(setupProblems.map((p) => `⚠️ ${p}`).join('\n') || '✅ fórum, tags, permissões e cargos ok', 1024),
          },
        ),
    ],
  });
}

// ── Roteamento ──────────────────────────────────────────────────────────────

export async function onChatInput(ctx: BotContext, interaction: ChatInputCommandInteraction) {
  try {
    if (interaction.commandName === 'card') await handleCard(ctx, interaction);
    else if (interaction.commandName === 'triagem') await handleTriage(ctx, interaction);
    else if (interaction.commandName === 'goalfy') await handleGoalfy(ctx, interaction);
  } catch (e) {
    logger.warn(`/${interaction.commandName} falhou`, e);
    const payload = { embeds: [errorEmbed(e)], components: [] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

export async function onSendToCard(ctx: BotContext, interaction: MessageContextMenuCommandInteraction) {
  const link = ctx.store.byThread(interaction.channelId);
  if (!link) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Este canal não está vinculado a um card.' });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const msg = interaction.targetMessage;
  const attachments = [...msg.attachments.values()].map((a) => `📎 ${a.name}: ${a.url}`);
  const body = [`${msg.member?.displayName ?? msg.author.username} (via ${interaction.user.displayName}):`, msg.content, ...attachments, msg.url]
    .filter(Boolean)
    .join('\n');
  try {
    await ctx.cards.comment(link.cardId, body);
    await interaction.editReply({ embeds: [okEmbed(`Mensagem enviada como comentário no card #${link.cardId}.`)] });
  } catch (e) {
    await interaction.editReply({ embeds: [errorEmbed(e)] });
  }
}

export async function onAutocomplete(ctx: BotContext, interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused(true);
  try {
    if (focused.name === 'fase') {
      const q = normalize(focused.value);
      const phases = (await ctx.board.phases()).filter((p) => normalize(p.title).includes(q));
      await interaction.respond(phases.slice(0, 25).map((p) => ({ name: truncate(`${ctx.board.isDone(p) ? '✅ ' : ''}${p.title}`, 100), value: p.id })));
      return;
    }
    if (focused.name === 'card') {
      const q = focused.value.trim();
      const choices: { name: string; value: string }[] = [];
      const linked = ctx.store.byThread(interaction.channelId);
      if (linked && !q) choices.push({ name: `Card deste tópico (#${linked.cardId})`, value: linked.cardId });
      const direct = q && parseCardRef(q);
      if (direct && /^\d+$/.test(direct)) choices.push({ name: `#${direct}`, value: direct });
      if (q.length >= 2) {
        const { cards } = await ctx.board.searchCards({ search: q, limit: 20 });
        for (const c of cards) choices.push({ name: truncate(`#${c.id} · ${c.title}${c.phaseName ? ` (${c.phaseName})` : ''}`, 100), value: c.id });
      }
      await interaction.respond(choices.slice(0, 25));
    }
  } catch (e) {
    logger.debug('Autocomplete falhou', e);
    await interaction.respond([]).catch(() => {});
  }
}

// ── Componentes dos cards ───────────────────────────────────────────────────

export async function onCardButton(ctx: BotContext, interaction: ButtonInteraction, action: string, arg: string[]) {
  try {
    if (action === 'move') {
      if (!(await requireTriage(ctx, interaction))) return;
      const cardId = arg[0]!;
      const [card, phases] = await Promise.all([ctx.cards.get(cardId), ctx.board.phases()]);
      const current = await ctx.board.phaseOf(card);
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `Mover **#${card.id} · ${truncate(card.title, 80)}** para:`,
        components: [phaseSelect(ctx.board, cardId, phases, current?.id)],
      });
    } else if (action === 'refresh') {
      await interaction.deferUpdate();
      const view = await showCard(ctx, arg[0]!);
      // No tópico, preserva a descrição original da mensagem fixada.
      const original = interaction.message.embeds[0]?.description;
      if (original && interaction.channel?.isThread()) view.embeds[0]!.setDescription(original);
      await interaction.editReply(view);
    } else if (action === 'list') {
      const [page, phaseId, ...search] = arg;
      await interaction.deferUpdate();
      await interaction.editReply(await listPage(ctx, Number(page) || 1, phaseId === '_' ? undefined : phaseId, search.join(':') || undefined));
    }
  } catch (e) {
    logger.warn(`Botão card:${action} falhou`, e);
    const payload = { embeds: [errorEmbed(e)], flags: MessageFlags.Ephemeral as const };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
}

export async function onCardSelect(ctx: BotContext, interaction: StringSelectMenuInteraction, action: string, arg: string[]) {
  try {
    if (action === 'moveTo') {
      if (!(await requireTriage(ctx, interaction))) return;
      await interaction.deferUpdate();
      const cardId = arg[0]!;
      await interaction.editReply(await requestMove(ctx, interaction.user.id, cardId, interaction.values[0]!, interaction.user.displayName));
    } else if (action === 'view') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await showCard(ctx, interaction.values[0]!));
    }
  } catch (e) {
    logger.warn(`Select card:${action} falhou`, e);
    const payload = { embeds: [errorEmbed(e)], flags: MessageFlags.Ephemeral as const };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
}
