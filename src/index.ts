import { ActivityType, Client, Events, GatewayIntentBits, type Interaction, MessageFlags, Partials } from 'discord.js';
import { loadBotConfig } from './config.js';
import type { BotContext } from './context.js';
import { onAutocomplete, onCardButton, onCardSelect, onChatInput, onSendToCard } from './discord/commands.js';
import { startSync } from './discord/sync.js';
import {
  onClassifyCancel,
  onClassifyNext,
  onClassifyModal,
  onClassifyOpen,
  onLegacyClassifySelect,
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
import { onFillAndMove, onMoveModal } from './discord/move.js';
import { errorEmbed } from './discord/ui.js';
import { BoardService } from './goalfy/board.js';
import { CardService } from './goalfy/cards.js';
import { GoalfyClient } from './goalfy/client.js';
import { logger } from './logger.js';
import { postLifecycle, startAlerts } from './discord/alerts.js';
import { prepareGuild } from './discord/setup.js';
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
      if (action === 'open') return onClassifyOpen(interaction);
      if (action === 'next') return onClassifyNext(ctx, interaction);
      if (action === 'cancel') return onClassifyCancel(interaction);
    }
    if (scope === 'card' && action === 'fill') return onFillAndMove(interaction, arg[0]!);
    if (scope === 'card') return onCardButton(ctx, interaction, action, arg);
  }

  if (interaction.isStringSelectMenu()) {
    if (scope === 'classify') return onLegacyClassifySelect(interaction);
    if (scope === 'card') return onCardSelect(ctx, interaction, action, arg);
  }

  if (interaction.isModalSubmit() && scope === 'modal') {
    if (action === 'classify') return onClassifyModal(ctx, interaction);
    if (action === 'create') return onCreateModal(ctx, interaction);
    if (action === 'link') return onLinkModal(ctx, interaction);
    if (action === 'waiting') return onWaitingModal(ctx, interaction);
    if (action === 'resolve') return onResolveModal(ctx, interaction);
    if (action === 'reject') return onRejectModal(ctx, interaction);
    if (action === 'move') return onMoveModal(ctx, interaction, arg[0]!);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  // Tempo de cada interação: "chegada" = do clique até o evento chegar ao bot (Discord/rede);
  // "resposta" = do evento até o bot terminar de responder. Lento acima de 1,5s vira WARN.
  const received = Date.now();
  const arrival = received - interaction.createdTimestamp;
  const name = 'customId' in interaction ? interaction.customId : interaction.isCommand() ? `/${interaction.commandName}` : interaction.type;
  try {
    await route(interaction);
  } catch (e) {
    logger.error('Erro ao tratar interação', e);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [errorEmbed(e)] }).catch(() => {});
    }
  } finally {
    const handling = Date.now() - received;
    const line = `Interação ${String(name).slice(0, 40)}: chegada ${arrival}ms, resposta ${handling}ms (gateway ${client.ws.ping}ms)`;
    if (arrival + handling > 1500) logger.warn(`${line}: LENTA`);
    else logger.debug(line);
  }
});

client.on(Events.ThreadCreate, (thread, newlyCreated) => {
  onThreadCreate(ctx, thread, newlyCreated).catch((e) => logger.error('Erro no ThreadCreate', e));
});

client.on(Events.MessageCreate, (message) => {
  onThreadMessage(ctx, message).catch((e) => logger.error('Erro no MessageCreate', e));
});

// Bot convidado com ele já rodando: registra os comandos e confere o servidor, sem precisar reiniciar.
client.on(Events.GuildCreate, (guild) => {
  if (guild.id !== config.DISCORD_GUILD_ID) return;
  logger.info(`Bot adicionado ao servidor "${guild.name}"`);
  prepareGuild(ctx).catch((e) => logger.error('Erro ao preparar o servidor', e));
});

client.on(Events.ThreadDelete, (thread) => {
  ctx.store.unlinkThread(thread.id);
  ctx.store.forgetTopic(thread.id);
});

let stopSync: (() => void) | undefined;
let stopAlerts: (() => void) | undefined;
let webhookServer: import('node:http').Server | undefined;

client.once(Events.ClientReady, async (c) => {
  logger.info(`Conectado como ${c.user.tag}`);
  // Primeiro, para que os avisos da inicialização (diagnóstico, Goalfy) também cheguem ao canal.
  stopAlerts = startAlerts(ctx);
  c.user.setActivity('o backlog na Goalfy', { type: ActivityType.Watching });
  try {
    const phases = await board.phases();
    await board.createForm().catch((e) => logger.warn('Não consegui ler o Formulário Inicial do board', e));
    logger.info(`Board ${board.boardId}: ${phases.map((p) => p.title).join(' → ')}`);
  } catch (e) {
    logger.error('Não consegui ler as fases do board. Confira GOALFY_TOKEN e GOALFY_BOARD_ID.', e);
  }
  await prepareGuild(ctx);

  // O banco guarda vínculos de UM ambiente da Goalfy. Trocar GOALFY_API_URL/board mantendo o banco
  // faz o bot acompanhar cards que o ambiente novo não conhece (403 em loop).
  const envId = `${config.GOALFY_API_URL}|${config.GOALFY_BOARD_ID}`;
  const previousEnv = ctx.store.get('goalfy.env');
  if (previousEnv && previousEnv !== envId && ctx.store.openLinks().length) {
    logger.warn(
      `O banco ${config.DATABASE_PATH} tem cards vinculados de outro ambiente (${previousEnv.split('|')[0]}). ` +
        'Use um DATABASE_PATH por ambiente (ex.: data/dev.db); esses cards serão encerrados após falharem algumas vezes.',
    );
  }
  ctx.store.set('goalfy.env', envId);
  stopSync = startSync(ctx);
  webhookServer = await startWebhookServer(ctx).catch((e) => {
    logger.error('Falha ao iniciar o servidor de webhook', e);
    return undefined;
  });

  const phases = await board.phases().catch(() => []);
  await postLifecycle(ctx, 'start', [
    `Board: **${phases.length} fases** · acompanhando **${ctx.store.openLinks().length} card(s)**`,
    `Webhook: ${webhookServer ? 'ligado (mudança de fase na hora)' : 'desligado (só polling)'} · sincronização a cada ${config.SYNC_INTERVAL_SECONDS}s`,
    `Cargo de triagem: ${config.DISCORD_TRIAGE_ROLE_IDS.length ? config.DISCORD_TRIAGE_ROLE_IDS.map((r) => `<@&${r}>`).join(' ') : '_não configurado (todos podem)_'}`,
  ]);
});

async function shutdown(signal: string) {
  logger.info(`${signal} recebido, encerrando…`);
  stopSync?.();
  stopAlerts?.();
  webhookServer?.close();
  await postLifecycle(ctx, 'stop', [`Motivo: ${signal === 'SIGTERM' ? 'reinício/deploy' : signal}`]);
  await client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => logger.error('unhandledRejection', e));

await client.login(config.DISCORD_TOKEN);
