import type { Client } from 'discord.js';
import type { BotConfig } from './config.js';
import type { BoardService } from './goalfy/board.js';
import type { CardService } from './goalfy/cards.js';
import type { GoalfyClient } from './goalfy/client.js';
import type { Store } from './store.js';

export interface BotContext {
  client: Client;
  config: BotConfig;
  goalfy: GoalfyClient;
  board: BoardService;
  cards: CardService;
  store: Store;
}
