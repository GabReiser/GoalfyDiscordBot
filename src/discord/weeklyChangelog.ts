/**
 * Changelog semanal: cards que entraram na fase de produção no período, por Tipo e Módulo
 * (campos do Formulário Inicial), postados no canal DISCORD_CHANGELOG_CHANNEL_ID com @everyone.
 *
 *  - Agendado: toda segunda às 08:00 (horário de Brasília), cobrindo os 7 dias anteriores.
 *    Se o bot estiver fora do ar às 08:00, posta assim que voltar (no mesmo dia).
 *  - Manual: /changelog [dias] mostra uma prévia (só para quem executou) com o botão Publicar.
 *
 * "Entrou em produção" = `createdAt` do histórico do card na fase final que não é cancelamento.
 * A Goalfy guarda um histórico por fase (reaproveitado se o card voltar), então vale a 1ª entrada.
 * A data de cada card fica no banco: só cards novos na fase são abertos a cada execução.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { mapLimit } from '../concurrency.js';
import type { BotContext } from '../context.js';
import { type Card, type FormField, parseApiDate, toCards } from '../goalfy/types.js';
import { logger } from '../logger.js';
import { normalize } from '../process.js';
import { errorEmbed, okEmbed, truncate } from './ui.js';

const TZ = 'America/Sao_Paulo';
const SEND_WEEKDAY = 1; // segunda
const SEND_MINUTES = 8 * 60; // 08:00
const DAY_MS = 86_400_000;
const NO_TYPE = 'Sem tipo';
const NO_MODULE = 'Sem módulo';

export interface ChangelogItem {
  title: string;
  url: string;
  type: string;
  module: string;
}

export interface ChangelogMessage {
  content?: string;
  embeds: EmbedBuilder[];
}

// ── Valores dos campos ──────────────────────────────────────────────────────

/** Valor de campo da Goalfy → lista de textos (aceita texto, lista ou lista em JSON). */
export function fieldTexts(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  const v = value.trim();
  if (v.startsWith('[')) {
    try {
      return fieldTexts(JSON.parse(v));
    } catch {
      // não era JSON: segue como texto
    }
  }
  return [v];
}

function valueOf(card: Card, field: FormField | undefined): string[] {
  if (!field) return [];
  return fieldTexts(card.initialForm?.fields.find((f) => f.infoId === field.fieldInfoId)?.value);
}

// ── Agrupamento e mensagens ─────────────────────────────────────────────────

const TYPE_STYLE: { pattern: RegExp; emoji: string; color: number }[] = [
  { pattern: /feature|funcionalidade|novidade/, emoji: '🚀', color: 0x6c5ce7 },
  { pattern: /melhoria|improvement/, emoji: '✨', color: 0x3498db },
  { pattern: /bug|correcao|fix/, emoji: '🐛', color: 0xe74c3c },
  { pattern: /debito|divida|refator/, emoji: '🔧', color: 0x95a5a6 },
  { pattern: /infra|devops/, emoji: '🛠️', color: 0x7f8c8d },
  { pattern: /discovery|spike|pesquisa/, emoji: '🔍', color: 0xf1c40f },
];
const typeStyle = (type: string) => TYPE_STYLE.find((s) => s.pattern.test(normalize(type))) ?? { emoji: '📌', color: 0x2ecc71 };

/** Ordena pela ordem das opções na Goalfy; o que não está lá vem depois (alfabético) e "sem" por último. */
function orderBy(options: string[], none: string) {
  const pos = new Map(options.map((o, i) => [normalize(o), i]));
  return (a: string, b: string) => {
    if (a === none || b === none) return Number(a === none) - Number(b === none);
    const pa = pos.get(normalize(a)) ?? Infinity;
    const pb = pos.get(normalize(b)) ?? Infinity;
    return pa - pb || a.localeCompare(b, 'pt-BR');
  };
}

export interface ChangelogGroup {
  type: string;
  modules: { module: string; items: ChangelogItem[] }[];
  count: number;
}

export function groupChangelog(items: ChangelogItem[], typeOptions: string[] = [], moduleOptions: string[] = []): ChangelogGroup[] {
  const byType = new Map<string, Map<string, ChangelogItem[]>>();
  for (const item of items) {
    const modules = byType.get(item.type) ?? new Map<string, ChangelogItem[]>();
    byType.set(item.type, modules);
    modules.set(item.module, [...(modules.get(item.module) ?? []), item]);
  }
  const typeOrder = orderBy(typeOptions, NO_TYPE);
  const moduleOrder = orderBy(moduleOptions, NO_MODULE);
  return [...byType.entries()]
    .sort(([a], [b]) => typeOrder(a, b))
    .map(([type, modules]) => ({
      type,
      count: [...modules.values()].reduce((n, l) => n + l.length, 0),
      modules: [...modules.entries()]
        .sort(([a], [b]) => moduleOrder(a, b))
        .map(([module, list]) => ({ module, items: [...list].sort((x, y) => x.title.localeCompare(y.title, 'pt-BR')) })),
    }));
}

const fmtDay = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' });

/** Título do período: "27/10 a 02/11" (o fim é exclusivo, então mostra o dia anterior). */
export const periodLabel = (from: Date, to: Date) => `${fmtDay(from)} a ${fmtDay(new Date(to.getTime() - 1))}`;

const EMBED_TEXT_MAX = 3900;
const MESSAGE_TEXT_MAX = 5800;
const MESSAGE_EMBEDS_MAX = 10;

/**
 * Uma mensagem com o cabeçalho (e o @everyone) e um embed por Tipo, com os Módulos como seções.
 * Tipos grandes continuam em outro embed; embeds que não cabem vão para a mensagem seguinte.
 */
export function renderChangelog(groups: ChangelogGroup[], from: Date, to: Date, mentionEveryone: boolean): ChangelogMessage[] {
  const total = groups.reduce((n, g) => n + g.count, 0);
  const header = [
    mentionEveryone ? '@everyone' : '',
    `## 📦 Changelog · ${periodLabel(from, to)}`,
    total
      ? `**${total} entrega(s)** em produção: ${groups.map((g) => `${typeStyle(g.type).emoji} ${g.type} (${g.count})`).join(' · ')}`
      : 'Nenhuma entrega chegou em produção nesse período.',
  ]
    .filter(Boolean)
    .join('\n');

  const embeds: EmbedBuilder[] = [];
  for (const g of groups) {
    const style = typeStyle(g.type);
    const lines = g.modules.flatMap((m, i) => [
      ...(i ? [''] : []),
      `**${m.module}**`,
      ...m.items.map((it) => `• [${truncate(it.title.replace(/[[\]]/g, ''), 150)}](${it.url})`),
    ]);
    let chunk: string[] = [];
    let part = 0;
    const flush = () => {
      if (!chunk.length) return;
      embeds.push(
        new EmbedBuilder()
          .setColor(style.color)
          .setTitle(`${style.emoji} ${g.type} · ${g.count}${part ? ' (continuação)' : ''}`)
          .setDescription(chunk.join('\n')),
      );
      part++;
      chunk = [];
    };
    for (const line of lines) {
      if ([...chunk, line].join('\n').length > EMBED_TEXT_MAX) flush();
      if (chunk.length || line) chunk.push(line);
    }
    flush();
  }

  const messages: ChangelogMessage[] = [{ content: header, embeds: [] }];
  let size = 0;
  for (const embed of embeds) {
    const len = (embed.data.title?.length ?? 0) + (embed.data.description?.length ?? 0);
    const current = messages[messages.length - 1]!;
    if (current.embeds.length >= MESSAGE_EMBEDS_MAX || size + len > MESSAGE_TEXT_MAX) {
      messages.push({ embeds: [embed] });
      size = len;
    } else {
      current.embeds.push(embed);
      size += len;
    }
  }
  return messages;
}

// ── Coleta na Goalfy ────────────────────────────────────────────────────────

/** Cards que entraram em produção em [from, to). */
export async function collectChangelog(ctx: BotContext, from: Date, to: Date) {
  const phases = (await ctx.board.phases()).filter((p) => ctx.board.isDone(p) && !ctx.board.isCancel(p));
  const form = await ctx.board.createForm();
  const typeField = form.fields.type;
  const moduleField = form.fields.module;
  const known = ctx.store.productionEntries();
  const opened = new Map<string, Card>();
  const inWindow: string[] = [];

  for (const phase of phases) {
    const cards = toCards(await ctx.goalfy.listCardsByPhase(phase.id));
    const unknown = cards.filter((c) => known.get(c.id)?.phaseId !== phase.id);
    if (unknown.length) logger.info(`Changelog: lendo a data de entrada em "${phase.title}" de ${unknown.length} card(s) novo(s) na fase`);
    await mapLimit(unknown, 5, async (c) => {
      try {
        const full = await ctx.cards.get(c.id);
        opened.set(c.id, full);
        const enteredAt = parseApiDate(full.phaseForms.find((h) => h.phaseId === phase.id)?.enteredAt)?.toISOString() ?? null;
        ctx.store.saveProductionEntry(c.id, phase.id, enteredAt);
        known.set(c.id, { phaseId: phase.id, enteredAt });
      } catch (e) {
        logger.warn(`Changelog: não consegui ler o card ${c.id}`, e);
      }
    });
    for (const c of cards) {
      const at = known.get(c.id)?.enteredAt;
      if (at && at >= from.toISOString() && at < to.toISOString()) inWindow.push(c.id);
    }
  }

  const cards = await mapLimit(inWindow, 5, async (id) => opened.get(id) ?? (await ctx.cards.get(id).catch(() => undefined)));
  const items: ChangelogItem[] = cards
    .filter((c): c is Card => !!c)
    .map((c) => ({
      title: c.title,
      url: ctx.board.cardUrl(c.id),
      type: valueOf(c, typeField)[0] ?? NO_TYPE,
      module: valueOf(c, moduleField)[0] ?? NO_MODULE,
    }));
  return groupChangelog(items, typeField?.options, moduleField?.options);
}

async function publish(ctx: BotContext, messages: ChangelogMessage[]) {
  const id = ctx.config.DISCORD_CHANGELOG_CHANNEL_ID;
  if (!id) throw new Error('DISCORD_CHANGELOG_CHANNEL_ID não está configurado.');
  const channel = await ctx.client.channels.fetch(id).catch(() => null);
  if (!channel?.isSendable()) throw new Error(`Não consigo postar no canal de changelog <#${id}>.`);
  for (const [i, m] of messages.entries()) {
    await channel.send({ content: m.content, embeds: m.embeds, allowedMentions: { parse: i === 0 ? ['everyone'] : [] } });
  }
}

// ── Agendamento (segunda 08:00, Brasília) ───────────────────────────────────

/** Dia da semana (0 = domingo), minutos desde 00:00 e data (AAAA-MM-DD) no horário de Brasília. */
export function brClock(d: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  return { weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute), day: `${parts.year}-${parts.month}-${parts.day}` };
}

/** Na segunda a partir das 08:00, se ainda não postou hoje: devolve o período (segunda 08:00 − 7 dias). */
export function dueWindow(now: Date, lastSentDay: string | undefined): { from: Date; to: Date; day: string } | undefined {
  const c = brClock(now);
  if (c.weekday !== SEND_WEEKDAY || c.minutes < SEND_MINUTES || c.day === lastSentDay) return undefined;
  const to = new Date(now.getTime() - (c.minutes - SEND_MINUTES) * 60_000);
  to.setUTCSeconds(0, 0);
  return { from: new Date(to.getTime() - 7 * DAY_MS), to, day: c.day };
}

const LAST_SENT_KEY = 'changelog:lastSentDay';
const RETRY_MS = 15 * 60_000;

export function startChangelogSchedule(ctx: BotContext): () => void {
  if (!ctx.config.DISCORD_CHANGELOG_CHANNEL_ID) return () => {};
  let running = false;
  let failedAt = 0;

  const check = async () => {
    const due = dueWindow(new Date(), ctx.store.get(LAST_SENT_KEY));
    if (!due || running || Date.now() - failedAt < RETRY_MS) return;
    running = true;
    try {
      const groups = await collectChangelog(ctx, due.from, due.to);
      if (groups.length) await publish(ctx, renderChangelog(groups, due.from, due.to, true));
      // Semana sem entregas: não marca @everyone à toa.
      else logger.info(`Changelog ${periodLabel(due.from, due.to)}: nenhuma entrega, nada postado`);
      ctx.store.set(LAST_SENT_KEY, due.day);
      if (groups.length) logger.info(`Changelog ${periodLabel(due.from, due.to)} postado`);
    } catch (e) {
      failedAt = Date.now();
      logger.error('Falha ao montar/postar o changelog semanal (nova tentativa em 15 min)', e);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void check(), 60_000);
  const first = setTimeout(() => void check(), 30_000);
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}

// ── /changelog (manual, com prévia) ─────────────────────────────────────────

const PREVIEW_TTL_MS = 15 * 60_000;
const previews = new Map<string, { messages: ChangelogMessage[]; at: number }>();

export async function handleChangelog(ctx: BotContext, interaction: ChatInputCommandInteraction) {
  const channelId = ctx.config.DISCORD_CHANGELOG_CHANNEL_ID;
  if (!channelId) throw new Error('DISCORD_CHANGELOG_CHANNEL_ID não está configurado.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const days = interaction.options.getInteger('dias') ?? 7;
  const to = new Date();
  const from = new Date(to.getTime() - days * DAY_MS);
  const groups = await collectChangelog(ctx, from, to);
  const messages = renderChangelog(groups, from, to, true);

  if (!groups.length) {
    await interaction.editReply({ content: `Nenhum card entrou em produção entre ${periodLabel(from, to)}. Nada para publicar.` });
    return;
  }
  for (const [k, v] of previews) if (Date.now() - v.at > PREVIEW_TTL_MS) previews.delete(k);
  previews.set(interaction.user.id, { messages, at: Date.now() });

  const first = messages[0]!;
  const more = messages.length > 1 ? `\n_(+${messages.length - 1} mensagem(ns) com o restante)_` : '';
  await interaction.editReply({
    content: `**Prévia** (só você vê). Ao publicar, vai para <#${channelId}> marcando **@everyone**.${more}\n\n${first.content!.replace('@everyone\n', '')}`,
    embeds: first.embeds,
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('changelog:publish').setStyle(ButtonStyle.Success).setLabel('Publicar').setEmoji('📣'),
        new ButtonBuilder().setCustomId('changelog:cancel').setStyle(ButtonStyle.Secondary).setLabel('Cancelar'),
      ),
    ],
  });
}

export async function onChangelogButton(ctx: BotContext, interaction: ButtonInteraction, action: string) {
  const preview = previews.get(interaction.user.id);
  if (action === 'cancel' || !preview) {
    previews.delete(interaction.user.id);
    await interaction.update({ content: action === 'cancel' ? 'Publicação cancelada.' : 'Prévia expirada. Rode /changelog de novo.', embeds: [], components: [] });
    return;
  }
  await interaction.deferUpdate();
  try {
    await publish(ctx, preview.messages);
    previews.delete(interaction.user.id);
    logger.info(`Changelog publicado manualmente por ${interaction.user.tag}`);
    await interaction.editReply({ content: '', embeds: [okEmbed(`Changelog publicado em <#${ctx.config.DISCORD_CHANGELOG_CHANNEL_ID}>.`)], components: [] });
  } catch (e) {
    await interaction.editReply({ content: '', embeds: [errorEmbed(e)], components: [] });
  }
}
