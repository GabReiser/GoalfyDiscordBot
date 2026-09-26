import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  time,
  TimestampStyles,
} from 'discord.js';
import type { BoardService } from '../goalfy/board.js';
import { GoalfyError } from '../goalfy/client.js';
import { type Card, type Phase, parseApiDate } from '../goalfy/types.js';
import { type Choice, FRONTS, ORIGINS, SEVERITIES, TYPES } from '../process.js';

export const COLORS = {
  brand: 0x6c5ce7,
  done: 0x2ecc71,
  info: 0x3498db,
  warn: 0xf1c40f,
  error: 0xe74c3c,
  muted: 0x95a5a6,
} as const;

/** IDs dos componentes. Formato `escopo:ação[:arg...]`. */
export const IDS = {
  // Painel de triagem no tópico
  triageCard: 'triage:card',
  triageLink: 'triage:link',
  triageWaiting: 'triage:waiting',
  triageResolve: 'triage:resolve',
  triageReject: 'triage:reject',
  // Classificação (passo 1 da criação)
  classify: (field: ClassifyField) => `classify:${field}`,
  classifyNext: 'classify:next',
  classifyCancel: 'classify:cancel',
  // Modais
  createModal: 'modal:create',
  linkModal: 'modal:link',
  waitingModal: 'modal:waiting',
  resolveModal: 'modal:resolve',
  rejectModal: 'modal:reject',
  // Card
  move: (cardId: string) => `card:move:${cardId}`,
  moveTo: (cardId: string) => `card:moveTo:${cardId}`,
  refresh: (cardId: string) => `card:refresh:${cardId}`,
  view: 'card:view',
  list: (page: number, phaseId: string | undefined, search: string | undefined) =>
    `card:list:${page}:${phaseId ?? '_'}:${(search ?? '').slice(0, 60)}`,
} as const;

export type ClassifyField = 'front' | 'type' | 'origin' | 'severity';

export const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const parseDate = parseApiDate;

export function errorText(e: unknown): string {
  if (e instanceof GoalfyError) return e.friendly;
  if (e instanceof Error) return e.message;
  return 'Erro inesperado.';
}

export const errorEmbed = (e: unknown) => new EmbedBuilder().setColor(COLORS.error).setDescription(`❌ ${errorText(e)}`);
export const okEmbed = (text: string) => new EmbedBuilder().setColor(COLORS.done).setDescription(`✅ ${text}`);
export const infoEmbed = (text: string) => new EmbedBuilder().setColor(COLORS.info).setDescription(text);

// ── Card ────────────────────────────────────────────────────────────────────

export function cardEmbed(board: BoardService, card: Card, phase?: Phase): EmbedBuilder {
  const phaseName = phase?.title ?? card.phaseName ?? '—';
  const done = phase ? board.isDone(phase) : false;
  const embed = new EmbedBuilder()
    .setColor(done ? COLORS.done : COLORS.brand)
    .setAuthor({ name: `Card #${card.id}` })
    .setTitle(truncate(card.title, 256))
    .setURL(board.cardUrl(card.id))
    .addFields(
      { name: 'Fase', value: `${done ? '✅' : '📍'} ${phaseName}`, inline: true },
      { name: 'Responsáveis', value: card.responsibles.join(', ') || '_ninguém ainda_', inline: true },
    );

  if (card.tags.length) embed.addFields({ name: 'Etiquetas', value: card.tags.map((t) => `\`${t}\``).join(' '), inline: true });
  const created = parseDate(card.createdAt);
  if (created) embed.addFields({ name: 'Criado', value: time(created, TimestampStyles.RelativeTime), inline: true });
  const due = parseDate(card.dueDate);
  if (due) embed.addFields({ name: 'Vencimento', value: time(due, TimestampStyles.ShortDate), inline: true });
  return embed.setTimestamp(parseDate(card.updatedAt) ?? null);
}

export function cardActions(board: BoardService, cardId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Abrir na Goalfy').setURL(board.cardUrl(cardId)),
    new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel('Mover fase').setEmoji('🔀').setCustomId(IDS.move(cardId)),
    new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Atualizar').setEmoji('🔄').setCustomId(IDS.refresh(cardId)),
  );
}

export function phaseSelect(board: BoardService, cardId: string, phases: Phase[], currentId?: string) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(IDS.moveTo(cardId))
    .setPlaceholder('Escolha a fase de destino')
    .addOptions(
      phases.slice(0, 25).map((p) => {
        const opt = new StringSelectMenuOptionBuilder()
          .setLabel(truncate(p.title, 100))
          .setValue(p.id)
          .setEmoji(p.id === currentId ? '📍' : board.isDone(p) ? '✅' : '➡️');
        if (p.id === currentId) opt.setDescription('Fase atual');
        else if (p.description) opt.setDescription(truncate(p.description, 100));
        return opt;
      }),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function listPager(page: number, hasNext: boolean, phaseId?: string, search?: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.list(page - 1, phaseId, search))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('◀️')
      .setDisabled(page <= 1),
    new ButtonBuilder().setCustomId('noop').setStyle(ButtonStyle.Secondary).setLabel(`Página ${page}`).setDisabled(true),
    new ButtonBuilder()
      .setCustomId(IDS.list(page + 1, phaseId, search))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('▶️')
      .setDisabled(!hasNext),
  );
}

export function cardPicker(cards: Card[]) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(IDS.view)
      .setPlaceholder('Ver detalhes de um card…')
      .addOptions(
        cards.slice(0, 25).map((c) => {
          const opt = new StringSelectMenuOptionBuilder().setLabel(truncate(`#${c.id} · ${c.title}`, 100)).setValue(c.id);
          if (c.phaseName) opt.setDescription(truncate(c.phaseName, 100));
          return opt;
        }),
      ),
  );
}

// ── Painel de triagem ───────────────────────────────────────────────────────

export function triagePanel() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(IDS.triageCard).setStyle(ButtonStyle.Success).setLabel('Criar card').setEmoji('📋'),
      new ButtonBuilder().setCustomId(IDS.triageLink).setStyle(ButtonStyle.Secondary).setLabel('Vincular card existente').setEmoji('🔗'),
      new ButtonBuilder().setCustomId(IDS.triageWaiting).setStyle(ButtonStyle.Secondary).setLabel('Pedir informação').setEmoji('⏳'),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(IDS.triageResolve).setStyle(ButtonStyle.Primary).setLabel('Resolvido sem card').setEmoji('✅'),
      new ButtonBuilder().setCustomId(IDS.triageReject).setStyle(ButtonStyle.Danger).setLabel('Não procede').setEmoji('❌'),
    ),
  ];
}

// ── Classificação (passo 1) ─────────────────────────────────────────────────

export interface Classification {
  front?: string;
  type?: string;
  origin?: string;
  severity?: string;
}

function select(field: ClassifyField, placeholder: string, choices: readonly Choice[], selected: string | undefined) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(IDS.classify(field))
      .setPlaceholder(placeholder)
      .addOptions(
        choices.map((c) => {
          const opt = new StringSelectMenuOptionBuilder()
            .setLabel(c.label)
            .setValue(c.value)
            .setEmoji(c.emoji)
            .setDefault(c.value === selected);
          if (c.description) opt.setDescription(truncate(c.description, 100));
          return opt;
        }),
      ),
  );
}

export function classifyMessage(c: Classification, error?: string) {
  const embed = new EmbedBuilder()
    .setColor(error ? COLORS.warn : COLORS.brand)
    .setTitle('📋 Classificar a demanda')
    .setDescription(
      [
        'Passo 1 de 2 — escolha **Tipo**, **Frente**, **Origem** e **Severidade**.',
        'A frente é sugerida a partir do tipo. Lembre: _a triagem classifica, Produto/Tecnologia prioriza._',
        error ? `\n⚠️ ${error}` : '',
      ].join('\n'),
    );
  return {
    embeds: [embed],
    components: [
      select('type', 'Tipo', TYPES, c.type),
      select('front', 'Frente', FRONTS, c.front),
      select('origin', 'Origem', ORIGINS, c.origin),
      select('severity', 'Severidade (para problemas/bugs)', SEVERITIES, c.severity),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(IDS.classifyNext).setStyle(ButtonStyle.Success).setLabel('Continuar').setEmoji('➡️'),
        new ButtonBuilder().setCustomId(IDS.classifyCancel).setStyle(ButtonStyle.Secondary).setLabel('Cancelar'),
      ),
    ],
  };
}

// ── Modais ──────────────────────────────────────────────────────────────────

const text = (id: string, style: TextInputStyle, opts: { value?: string; max: number; required?: boolean; placeholder?: string }) => {
  const input = new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(opts.max).setRequired(opts.required ?? false);
  if (opts.value) input.setValue(truncate(opts.value, opts.max));
  if (opts.placeholder) input.setPlaceholder(opts.placeholder);
  return input;
};

const label = (name: string, input: TextInputBuilder, description?: string) => {
  const l = new LabelBuilder().setLabel(name).setTextInputComponent(input);
  return description ? l.setDescription(description) : l;
};

export interface CardDraft {
  title: string;
  description: string;
  expectedResult: string;
  client: string;
  ticketLink: string;
}

export function cardModal(d: CardDraft) {
  return new ModalBuilder()
    .setCustomId(IDS.createModal)
    .setTitle('Criar card — passo 2 de 2')
    .addLabelComponents(
      label('Título', text('title', TextInputStyle.Short, { value: d.title, max: 100, required: true })),
      label(
        'Descrição',
        text('description', TextInputStyle.Paragraph, { value: d.description, max: 4000, required: true }),
        'Resumo suficiente para entender a necessidade',
      ),
      label(
        'Resultado esperado',
        text('expectedResult', TextInputStyle.Paragraph, { value: d.expectedResult, max: 1000 }),
        'O que caracteriza a demanda como resolvida',
      ),
      label('Cliente / Organização', text('client', TextInputStyle.Short, { value: d.client, max: 200 }), 'Quando aplicável'),
      label(
        'Link do ticket N1',
        text('ticketLink', TextInputStyle.Short, { value: d.ticketLink, max: 300, placeholder: 'https://…' }),
        'Quando houver',
      ),
    );
}

export function linkModal() {
  return new ModalBuilder()
    .setCustomId(IDS.linkModal)
    .setTitle('Vincular card existente')
    .addLabelComponents(
      label(
        'ID ou link do card',
        text('card', TextInputStyle.Short, { max: 200, required: true, placeholder: 'https://app.goalfy.com.br/card/12345' }),
        'Use quando a ocorrência já tem card (duplicidade)',
      ),
    );
}

export function waitingModal(missing: string[]) {
  return new ModalBuilder()
    .setCustomId(IDS.waitingModal)
    .setTitle('Pedir informações ao solicitante')
    .addLabelComponents(
      label(
        'O que está faltando?',
        text('message', TextInputStyle.Paragraph, {
          max: 1500,
          required: true,
          value: missing.length ? `Pode complementar com:\n${missing.map((m) => `• ${m}`).join('\n')}` : undefined,
        }),
      ),
    );
}

export function resolveModal() {
  return new ModalBuilder()
    .setCustomId(IDS.resolveModal)
    .setTitle('Resolvido na triagem')
    .addLabelComponents(
      label(
        'Como foi resolvido?',
        text('message', TextInputStyle.Paragraph, {
          max: 1500,
          required: true,
          placeholder: 'Ex.: era configuração do funil — orientado o cliente a…',
        }),
        'Dúvida, configuração, uso incorreto, orientação ao usuário…',
      ),
    );
}

export const REJECT_REASONS: Choice[] = [
  { value: 'Comportamento esperado', label: 'Comportamento esperado', emoji: '📘' },
  { value: 'Duplicidade', label: 'Duplicidade', emoji: '👯' },
  { value: 'Não reproduzido', label: 'Problema não reproduzido', emoji: '🔍' },
  { value: 'Outro', label: 'Outro motivo', emoji: '💬' },
];

export function rejectModal() {
  return new ModalBuilder()
    .setCustomId(IDS.rejectModal)
    .setTitle('Não procede')
    .addLabelComponents(
      new LabelBuilder().setLabel('Motivo').setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId('reason')
          .addOptions(REJECT_REASONS.map((r) => new StringSelectMenuOptionBuilder().setLabel(r.label).setValue(r.value).setEmoji(r.emoji))),
      ),
      label('Detalhes', text('message', TextInputStyle.Paragraph, { max: 1500, required: true })),
    );
}
