import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  type ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  time,
  TimestampStyles,
} from 'discord.js';
import type { BoardService } from '../goalfy/board.js';
import { GoalfyError } from '../goalfy/client.js';
import { fieldKind, isMulti } from '../goalfy/formPlan.js';
import { type Card, type FormField, type Phase, parseApiDate } from '../goalfy/types.js';
import type { Choice } from '../process.js';

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
  classify: (fieldInfoId: string) => `classify:${fieldInfoId}`,
  classifyNext: 'classify:next',
  classifyCancel: 'classify:cancel',
  // Modais
  createModal: 'modal:create',
  linkModal: 'modal:link',
  waitingModal: 'modal:waiting',
  resolveModal: 'modal:resolve',
  rejectModal: 'modal:reject',
  moveModal: (cardId: string) => `modal:move:${cardId}`,
  // Card
  move: (cardId: string) => `card:move:${cardId}`,
  moveTo: (cardId: string) => `card:moveTo:${cardId}`,
  refresh: (cardId: string) => `card:refresh:${cardId}`,
  fillAndMove: (cardId: string) => `card:fill:${cardId}`,
  view: 'card:view',
  list: (page: number, phaseId: string | undefined, search: string | undefined) =>
    `card:list:${page}:${phaseId ?? '_'}:${(search ?? '').slice(0, 60)}`,
} as const;


export const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const parseDate = parseApiDate;

export function errorText(e: unknown): string {
  if (e instanceof GoalfyError) return e.friendly;
  if (e instanceof DiscordAPIError && e.code === 50035) {
    return 'O Discord recusou o formulário montado pelo bot. Tente de novo; se continuar, avise quem mantém o bot (o detalhe fica no log).';
  }
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

// ── Formulários dinâmicos (campos vindos da Goalfy) ─────────────────────────

/** Valores escolhidos/digitados por fieldInfoId. */
export type FormValues = Record<string, string[]>;

/** Rótulo de componente no Discord: máx. 45 caracteres; obrigatório ganha "*". */
const fieldLabel = (f: FormField) => truncate(`${f.name}${f.required ? ' *' : ''}`, 45);

/**
 * Select de um campo de seleção. O valor de cada opção é o ÍNDICE (opções da Goalfy podem
 * passar dos 100 caracteres permitidos em `value`); `selectedOptions` converte de volta.
 */
function fieldSelect(customId: string, f: FormField, selected: string[], inModal = false) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(fieldLabel(f))
    .addOptions(
      f.options.slice(0, 25).map((o, i) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(truncate(o, 100))
          .setValue(String(i))
          .setDefault(selected.includes(o)),
      ),
    );
  if (isMulti(f)) menu.setMinValues(f.required ? 1 : 0).setMaxValues(Math.min(f.options.length, 25));
  // "required" só existe em selects dentro de modais; numa mensagem o Discord recusaria o componente.
  if (inModal && !f.required) menu.setRequired(false);
  return menu;
}

export const selectedOptions = (f: FormField, indexes: readonly string[]) =>
  indexes.map((i) => f.options[Number(i)]).filter((o): o is string => o !== undefined);

/** Passo 1 da criação: um select por campo de seleção do Formulário Inicial. */
export function classifyMessage(fields: FormField[], values: FormValues, error?: string) {
  const help = fields
    .filter((f) => f.helpText)
    .map((f) => `• **${f.name}**: ${truncate(f.helpText!, 150)}`)
    .join('\n');
  const embed = new EmbedBuilder()
    .setColor(error ? COLORS.warn : COLORS.brand)
    .setTitle('📋 Classificar a demanda')
    .setDescription(
      [
        fields.length
          ? 'Passo 1 de 2: escolha as opções abaixo (as que já vieram marcadas foram deduzidas do tópico).'
          : 'Passo 1 de 2: nada para classificar, clique em Continuar.',
        '_A triagem classifica; Produto/Tecnologia prioriza._',
        help,
        error ? `\n⚠️ ${error}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  return {
    embeds: [embed],
    components: [
      ...fields.map((f) =>
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(fieldSelect(IDS.classify(f.fieldInfoId), f, values[f.fieldInfoId] ?? [])),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(IDS.classifyNext).setStyle(ButtonStyle.Success).setLabel('Continuar').setEmoji('➡️'),
        new ButtonBuilder().setCustomId(IDS.classifyCancel).setStyle(ButtonStyle.Secondary).setLabel('Cancelar'),
      ),
    ],
  };
}

/**
 * Valor inicial aceito pelo Discord: em campo de uma linha (Short), quebra de linha faz o modal
 * inteiro ser recusado (COMPONENT_VALIDATION_FAILED), então vira espaço.
 */
export function inputValue(value: string, style: TextInputStyle, max: number): string {
  const v = style === TextInputStyle.Short ? value.replace(/\s+/g, ' ').trim() : value.trim();
  return truncate(v, max);
}

const text = (id: string, style: TextInputStyle, opts: { value?: string; max: number; required?: boolean; placeholder?: string }) => {
  const input = new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(opts.max).setRequired(opts.required ?? false);
  const value = opts.value && inputValue(opts.value, style, opts.max);
  if (value) input.setValue(value);
  if (opts.placeholder) input.setPlaceholder(truncate(opts.placeholder, 100));
  return input;
};

const label = (name: string, input: TextInputBuilder, description?: string) => {
  const l = new LabelBuilder().setLabel(truncate(name, 45)).setTextInputComponent(input);
  return description ? l.setDescription(truncate(description, 100)) : l;
};

/** Id do componente de um campo dentro de um modal. */
export const fieldInputId = (fieldInfoId: string) => `f:${fieldInfoId}`;

/** Componente de modal para um campo da Goalfy (texto curto, longo ou select). */
export function fieldInput(f: FormField, value: string[] = []): LabelBuilder {
  const kind = fieldKind(f);
  if (kind === 'select') {
    return new LabelBuilder()
      .setLabel(fieldLabel(f))
      .setStringSelectMenuComponent(fieldSelect(fieldInputId(f.fieldInfoId), f, value, true))
      .setDescription(truncate(f.helpText ?? (isMulti(f) ? 'Pode escolher mais de uma' : 'Escolha uma opção'), 100));
  }
  const placeholder = f.options.length ? `Ex.: ${f.options.slice(0, 4).join(', ')}` : undefined;
  const style = kind === 'longtext' ? TextInputStyle.Paragraph : TextInputStyle.Short;
  return label(
    fieldLabel(f),
    text(fieldInputId(f.fieldInfoId), style, { value: value[0], max: kind === 'longtext' ? 4000 : 1000, required: f.required, placeholder }),
    f.helpText,
  );
}

/** Passo 2 da criação: título + campos de texto (e selects que não couberam no passo 1). */
export function cardModal(title: string, fields: FormField[], values: FormValues) {
  return new ModalBuilder()
    .setCustomId(IDS.createModal)
    .setTitle('Criar card: passo 2 de 2')
    .addLabelComponents(
      label('Título do card *', text('title', TextInputStyle.Short, { value: title, max: 100, required: true })),
      ...fields.map((f) => fieldInput(f, values[f.fieldInfoId])),
    );
}

/** Modal com os campos obrigatórios exigidos para mover o card. */
export function moveFieldsModal(cardId: string, phaseTitle: string, fields: FormField[]) {
  return new ModalBuilder()
    .setCustomId(IDS.moveModal(cardId))
    .setTitle(truncate(`Mover para ${phaseTitle}`, 45))
    .addLabelComponents(...fields.map((f) => fieldInput(f)));
}

/** Lê os valores de um modal para os campos informados (texto → [valor]; select → opções escolhidas). */
export function readModalValues(interaction: ModalSubmitInteraction, fields: FormField[]): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const id = fieldInputId(f.fieldInfoId);
    try {
      out[f.fieldInfoId] =
        fieldKind(f) === 'select'
          ? selectedOptions(f, interaction.fields.getStringSelectValues(id))
          : [interaction.fields.getTextInputValue(id).trim()].filter(Boolean);
    } catch {
      out[f.fieldInfoId] = [];
    }
  }
  return out;
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
