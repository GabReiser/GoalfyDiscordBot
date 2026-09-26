import { ActivityType, Client, Events, GatewayIntentBits, type Interaction, MessageFlags, Partials } from 'discord.js';
import { loadBotConfig } from './config.js';
import type { BotContext } from './context.js';
import { onAutocomplete, onCardButton, onCardSelect, onChatInput, onSendToCard } from './discord/commands.js';
import { startSync } from './discord/sync.js';
import {
  onClassifyCancel,
  onClassifyNext,
  onClassifySelect,
  onCreateModal,
  onLinkButton,
  onLinkModal,
  onRejectButton,
  onRejectModal,
  onResolveButton,
  onResolveModal,
  onThreadCreate,
  onThreadMessage,
  onWaitingButton,
  onWaitingModal,
  startCardFlow,
} from './discord/triage.js';
import { errorEmbed, type ClassifyField } from './discord/ui.js';
import { BoardService } from './goalfy/board.js';
import { CardService } from './goalfy/cards.js';
import { GoalfyClient } from './goalfy/client.js';
import { logger } from './logger.js';
import { Store } from './store.js';
import { startWebhookServer } from './webhook.js';

const config = loadBotConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Privilegiado: necessário para ler a mensagem inicial dos tópicos.
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const goalfy = new GoalfyClient(config.GOALFY_API_URL, config.GOALFY_TOKEN);
const board = new BoardService(goalfy, config);
const ctx: BotContext = {
  client,
  config,
  goalfy,
  board,
  cards: new CardService(goalfy, board),
  store: new Store(config.DATABASE_PATH),
};

async function route(interaction: Interaction) {
  if (interaction.isAutocomplete()) return onAutocomplete(ctx, interaction);
  if (interaction.isChatInputCommand()) return onChatInput(ctx, interaction);
  if (interaction.isMessageContextMenuCommand()) return onSendToCard(ctx, interaction);

  if (!('customId' in interaction)) return;
  const [scope, action = '', ...arg] = interaction.customId.split(':');

  if (interaction.isButton()) {
    if (scope === 'triage') {
      if (action === 'card') return startCardFlow(ctx, interaction);
      if (action === 'link') return onLinkButton(ctx, interaction);
      if (action === 'waiting') return onWaitingButton(ctx, interaction);
      if (action === 'resolve') return onResolveButton(ctx, interaction);
      if (action === 'reject') return onRejectButton(ctx, interaction);
    }
    if (scope === 'classify') {
      if (action === 'next') return onClassifyNext(ctx, interaction);
      if (action === 'cancel') return onClassifyCancel(interaction);
    }
    if (scope === 'card') return onCardButton(ctx, interaction, action, arg);
  }

  if (interaction.isStringSelectMenu()) {
    if (scope === 'classify') return onClassifySelect(interaction, action as ClassifyField);
    if (scope === 'card') return onCardSelect(ctx, interaction, action, arg);
  }

  if (interaction.isModalSubmit() && scope === 'modal') {
    if (action === 'create') return onCreateModal(ctx, interaction);
    if (action === 'link') return onLinkModal(ctx, interaction);
    if (action === 'waiting') return onWaitingModal(ctx, interaction);
    if (action === 'resolve') return onResolveModal(ctx, interaction);
    if (action === 'reject') return onRejectModal(ctx, interaction);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await route(interaction);
  } catch (e) {
    logger.error('Erro ao tratar interação', e);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [errorEmbed(e)] }).catch(() => {});
    }
  }
});

client.on(Events.ThreadCreate, (thread, newlyCreated) => {
  onThreadCreate(ctx, thread, newlyCreated).catch((e) => logger.error('Erro no ThreadCreate', e));
});

client.on(Events.MessageCreate, (message) => {
  onThreadMessage(ctx, message).catch((e) => logger.error('Erro no MessageCreate', e));
});

client.on(Events.ThreadDelete, (thread) => {
  ctx.store.unlinkThread(thread.id);
  ctx.store.forgetTopic(thread.id);
});

let stopSync: (() => void) | undefined;
let webhookServer: import('node:http').Server | undefined;

client.once(Events.ClientReady, async (c) => {
  logger.info(`Conectado como ${c.user.tag}`);
  c.user.setActivity('o backlog na Goalfy', { type: ActivityType.Watching });
  try {
    const phases = await board.phases();
    logger.info(`Board ${board.boardId}: ${phases.map((p) => p.title).join(' → ')}`);
  } catch (e) {
    logger.error('Não consegui ler as fases do board. Confira GOALFY_TOKEN e GOALFY_BOARD_ID.', e);
  }
  if (!config.DISCORD_FORUM_CHANNEL_IDS.length) logger.warn('DISCORD_FORUM_CHANNEL_IDS vazio: nenhum fórum será monitorado.');
  stopSync = startSync(ctx);
  webhookServer = await startWebhookServer(ctx).catch((e) => {
    logger.error('Falha ao iniciar o servidor de webhook', e);
    return undefined;
  });
});

async function shutdown(signal: string) {
  logger.info(`${signal} recebido, encerrando…`);
  stopSync?.();
  webhookServer?.close();
  await client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => logger.error('unhandledRejection', e));

await client.login(config.DISCORD_TOKEN);
