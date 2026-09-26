import { z } from 'zod';

try {
  process.loadEnvFile();
} catch {
  // Sem .env: variáveis vêm do ambiente (Docker, PM2, etc.)
}

const csv = z
  .string()
  .optional()
  .transform((s) =>
    (s ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const optional = z
  .string()
  .optional()
  .transform((s) => (s?.trim() ? s.trim() : undefined));

const goalfySchema = z.object({
  GOALFY_TOKEN: z.string().min(1, 'GOALFY_TOKEN é obrigatório'),
  GOALFY_API_URL: z.url().default('https://api.goalfy.com.br/api'),
  GOALFY_APP_URL: z.url().default('https://app.goalfy.com.br'),
  GOALFY_BOARD_ID: optional,
  GOALFY_MODEL_ID: optional,
  GOALFY_FIELD_TITLE: optional,
  GOALFY_FIELD_DESCRIPTION: optional,
  GOALFY_FIELD_EXPECTED_RESULT: optional,
  GOALFY_FIELD_FRONT: optional,
  GOALFY_FIELD_TYPE: optional,
  GOALFY_FIELD_ORIGIN: optional,
  GOALFY_FIELD_CLIENT: optional,
  GOALFY_FIELD_SEVERITY: optional,
  GOALFY_FIELD_DISCORD_LINK: optional,
  GOALFY_FIELD_TICKET_LINK: optional,
  GOALFY_FIELD_REQUESTER: optional,
  GOALFY_DONE_PHASES: csv,
});

const botSchema = goalfySchema.extend({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN é obrigatório'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID é obrigatório'),
  DISCORD_GUILD_ID: z.string().min(1, 'DISCORD_GUILD_ID é obrigatório'),
  DISCORD_FORUM_CHANNEL_IDS: csv,
  DISCORD_TRIAGE_ROLE_IDS: csv,
  DISCORD_TRIAGE_CHANNEL_ID: optional,
  STALE_TOPIC_HOURS: z.coerce.number().min(0).default(24),
  GOALFY_BOARD_ID: z.string().min(1, 'GOALFY_BOARD_ID é obrigatório'),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(120),
  WEBHOOK_PUBLIC_URL: z.url().optional().or(z.literal('').transform(() => undefined)),
  WEBHOOK_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEBHOOK_SECRET: optional,
  SYNC_COMMENTS: z.stringbool().default(true),
  ARCHIVE_ON_DONE: z.stringbool().default(true),
  DATABASE_PATH: z.string().default('data/bot.db'),
});

export type GoalfyConfig = z.infer<typeof goalfySchema>;
export type BotConfig = z.infer<typeof botSchema>;

function parse<T extends z.ZodType>(schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`Configuração inválida:\n${issues}\n\nVeja o arquivo .env.example.`);
    process.exit(1);
  }
  return result.data;
}

export const loadGoalfyConfig = () => parse(goalfySchema);
export const loadBotConfig = () => parse(botSchema);
