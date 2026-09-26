/**
 * Movimentação de cards respeitando os formulários de fase do board.
 *
 * Regras (as mesmas pretendidas pelo backend da Goalfy):
 *  - ao AVANÇAR, os campos obrigatórios da fase atual precisam estar preenchidos
 *    (ex.: "Mapa para Testes" em Desenvolvido antes de ir para QA);
 *  - ao entrar numa fase FINAL, os obrigatórios dela vão junto (ex.: "Motivo do arquivamento").
 *
 * Quando falta algo, o bot mostra um botão que abre um modal com esses campos.
 * O modal precisa ser a primeira resposta do clique, então o plano fica em memória.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { BotContext } from '../context.js';
import { InvalidFieldValuesError } from '../goalfy/cards.js';
import { type MoveFieldsPlan, planMoveFields } from '../goalfy/formPlan.js';
import { type Card, isFilled, type Phase } from '../goalfy/types.js';
import { logger } from '../logger.js';
import { syncCard } from './sync.js';
import { COLORS, errorEmbed, type FormValues, IDS, infoEmbed, moveFieldsModal, okEmbed, readModalValues } from './ui.js';

interface PreparedMove {
  card: Card;
  current?: Phase;
  target: Phase;
  plan: MoveFieldsPlan;
}

const PENDING_TTL_MS = 15 * 60_000;
const pending = new Map<string, PreparedMove & { at: number }>();
const pendingKey = (userId: string, cardId: string) => `${userId}:${cardId}`;

export async function prepareMove(ctx: BotContext, cardId: string, phaseRef: string): Promise<PreparedMove> {
  const target = await ctx.board.phase(phaseRef);
  if (!target) throw new Error('Fase não encontrada neste board.');
  const card = await ctx.cards.get(cardId);
  const current = await ctx.board.phaseOf(card);
  if (current?.id === target.id) throw new Error(`O card já está em **${target.title}**.`);

  const forward = current ? target.index > current.index : false;
  const currentRequired = forward && current ? (await ctx.board.phaseFields(current)).filter((f) => f.required) : [];
  const history = current && card.phaseForms.find((h) => h.phaseId === current.id);
  const filled = new Set(history?.fields.filter((f) => isFilled(f.value)).map((f) => f.infoId) ?? []);
  const targetIsDone = ctx.board.isDone(target);
  const targetRequired = targetIsDone ? (await ctx.board.phaseFields(target)).filter((f) => f.required) : [];

  const plan = planMoveFields({ forward, currentRequired, filledInfoIds: filled, targetIsDone, targetRequired });
  // Sem o formulário da fase atual no histórico, não há onde gravar os campos de saída.
  if (plan.leave.length && !history?.formId && !plan.blocked.length) plan.blocked = [...plan.leave, ...plan.done];
  return { card, current, target, plan };
}

async function executeMove(ctx: BotContext, m: PreparedMove, values: FormValues, byName: string) {
  if (m.plan.leave.length && m.current) await ctx.cards.fillPhaseFields(m.card, m.current.id, m.plan.leave, values);
  await ctx.cards.move(m.card.id, m.target, m.plan.done.length ? { fields: m.plan.done, values } : undefined);
  await ctx.cards.comment(m.card.id, `Movido para "${m.target.title}" por ${byName}.`).catch(() => {});
  await syncCard(ctx, m.card.id, { by: byName, comments: false });
}

function fieldList(m: PreparedMove) {
  const lines = [
    ...m.plan.leave.map((f) => `• **${f.name}**: obrigatório em *${m.current?.title}* antes de avançar`),
    ...m.plan.done.map((f) => `• **${f.name}**: exigido por *${m.target.title}*`),
  ];
  return lines.join('\n');
}

const goalfyButton = (ctx: BotContext, cardId: string) =>
  new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Abrir na Goalfy').setURL(ctx.board.cardUrl(cardId));

/**
 * Pede para mover (já com a interação deferida). Move na hora se nada faltar; senão
 * responde com o botão "Preencher e mover" ou explica o que precisa ser feito na Goalfy.
 */
export async function requestMove(ctx: BotContext, userId: string, cardId: string, phaseRef: string, byName: string) {
  const m = await prepareMove(ctx, cardId, phaseRef);

  if (m.plan.blocked.length) {
    return {
      content: '',
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.warn)
          .setTitle(`Não consigo mover para ${m.target.title} pelo Discord`)
          .setDescription(`Estes campos precisam ser preenchidos na Goalfy:\n${fieldList(m)}`),
      ],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(goalfyButton(ctx, cardId))],
    };
  }

  if (!m.plan.leave.length && !m.plan.done.length) {
    await executeMove(ctx, m, {}, byName);
    return { content: '', embeds: [okEmbed(`Card [#${cardId}](${ctx.board.cardUrl(cardId)}) movido para **${m.target.title}**.`)], components: [] };
  }

  pending.set(pendingKey(userId, cardId), { ...m, at: Date.now() });
  return {
    content: '',
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle(`Para mover para ${m.target.title}`)
        .setDescription(`Preencha antes:\n${fieldList(m)}`),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(IDS.fillAndMove(cardId)).setStyle(ButtonStyle.Primary).setLabel('Preencher e mover').setEmoji('📝'),
        goalfyButton(ctx, cardId),
      ),
    ],
  };
}

/** Botão "Preencher e mover": abre o modal (síncrono, a partir do plano em memória). */
export async function onFillAndMove(interaction: ButtonInteraction, cardId: string) {
  const m = pending.get(pendingKey(interaction.user.id, cardId));
  if (!m || Date.now() - m.at > PENDING_TTL_MS) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Esse pedido expirou. Use **Mover fase** de novo.' });
    return;
  }
  await interaction.showModal(moveFieldsModal(cardId, m.target.title, [...m.plan.leave, ...m.plan.done]));
}

export async function onMoveModal(ctx: BotContext, interaction: ModalSubmitInteraction, cardId: string) {
  const key = pendingKey(interaction.user.id, cardId);
  const m = pending.get(key);
  if (!m) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Esse pedido expirou. Use **Mover fase** de novo.' });
    return;
  }
  const values = readModalValues(interaction, [...m.plan.leave, ...m.plan.done]);
  if (interaction.isFromMessage()) await interaction.update({ embeds: [infoEmbed('⏳ Movendo o card…')], components: [] });
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await executeMove(ctx, m, values, interaction.user.displayName);
    pending.delete(key);
    await interaction.editReply({ embeds: [okEmbed(`Card [#${cardId}](${ctx.board.cardUrl(cardId)}) movido para **${m.target.title}**.`)], components: [] });
  } catch (e) {
    logger.warn(`Falha ao mover o card ${cardId} com campos`, e);
    const retry =
      e instanceof InvalidFieldValuesError
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(IDS.fillAndMove(cardId)).setStyle(ButtonStyle.Primary).setLabel('Corrigir e mover').setEmoji('📝'),
            ),
          ]
        : [];
    await interaction.editReply({ embeds: [errorEmbed(e)], components: retry });
  }
}
