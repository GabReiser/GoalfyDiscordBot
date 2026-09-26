/**
 * Registra os slash commands no servidor (instantâneo, por ser por guild).
 * Uso: npm run deploy-commands
 *
 * Normalmente não é necessário: o bot registra os comandos sozinho ao iniciar
 * e quando é convidado para o servidor. Útil para forçar o registro sem reiniciar.
 */
import { DiscordAPIError, REST, Routes } from 'discord.js';
import { loadBotConfig } from '../config.js';
import { commandData } from '../discord/commands.js';
import { inviteUrl } from '../discord/setup.js';

const config = loadBotConfig();
const rest = new REST().setToken(config.DISCORD_TOKEN);

try {
  const result = (await rest.put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID), {
    body: commandData,
  })) as unknown[];
  console.log(`✅ ${result.length} comando(s) registrados no servidor ${config.DISCORD_GUILD_ID}:`);
  for (const c of commandData) console.log(`   • ${'description' in c && c.description ? `/${c.name}` : c.name}`);
} catch (e) {
  if (e instanceof DiscordAPIError && e.status === 401) {
    console.error('❌ 401: DISCORD_TOKEN inválido. Gere outro em Developer Portal → Bot → Reset Token.');
  } else if (e instanceof DiscordAPIError && (e.code === 50001 || e.status === 403)) {
    console.error(`❌ O bot ainda não está no servidor ${config.DISCORD_GUILD_ID} (Missing Access).`);
    console.error(`   Peça a um admin do servidor para abrir:\n   ${inviteUrl(config.DISCORD_CLIENT_ID)}`);
  } else {
    console.error('❌ Falha ao registrar os comandos:', e instanceof Error ? e.message : e);
  }
  process.exitCode = 1;
}
