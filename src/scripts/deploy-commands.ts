/**
 * Registra os slash commands no servidor (instantâneo, por ser por guild).
 * Uso: npm run deploy-commands
 */
import { REST, Routes } from 'discord.js';
import { loadBotConfig } from '../config.js';
import { commandData } from '../discord/commands.js';

const config = loadBotConfig();
const rest = new REST().setToken(config.DISCORD_TOKEN);

const result = (await rest.put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID), {
  body: commandData,
})) as unknown[];

console.log(`✅ ${result.length} comando(s) registrados no servidor ${config.DISCORD_GUILD_ID}:`);
for (const c of commandData) console.log(`   • ${'description' in c && c.description ? `/${c.name}` : c.name}`);
