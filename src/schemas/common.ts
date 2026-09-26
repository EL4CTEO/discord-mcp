import { z } from "zod";

/**
 * Shared argument schemas.
 *
 * Every reference accepts a name OR an ID, which is the single biggest
 * usability win for an agent: it never has to call a lookup tool first just to
 * turn "general" into a snowflake.
 */
export const guildRef = z
  .string()
  .min(1)
  .describe("Server name or ID. Optional when the bot is in one server or DISCORD_DEFAULT_GUILD is set.");

export const channelRef = z
  .string()
  .min(1)
  .describe("Channel or thread: name ('general'), #mention or ID.");

export const memberRef = z
  .string()
  .min(1)
  .describe("Member: username, nickname, @mention or ID.");

export const roleRef = z
  .string()
  .min(1)
  .describe("Role: name ('Moderator'), @mention or ID.");

export const messageId = z
  .string()
  .regex(/^\d{17,20}$/, "Message IDs are 17-20 digit snowflakes")
  .describe("Message ID (17-20 digits).");

export const detail = z
  .enum(["compact", "full"])
  .default("compact")
  .describe("compact returns only commonly needed fields (default, cheaper); full includes extra metadata.");

export const auditReason = z
  .string()
  .max(512)
  .optional()
  .describe("Reason recorded in the audit log.");

/** Rich embed, mirroring Discord's own limits so bad input fails locally. */
export const embedSchema = z
  .object({
    title: z.string().max(256).optional(),
    description: z.string().max(4096).optional(),
    url: z.url().optional(),
    color: z
      .union([z.string().regex(/^#?[0-9a-fA-F]{6}$/), z.number().int().min(0).max(0xffffff)])
      .optional()
      .describe("Accent colour as '#5865F2' or an integer."),
    timestamp: z.iso.datetime().optional(),
    author: z.object({ name: z.string().max(256), url: z.url().optional(), icon_url: z.url().optional() }).optional(),
    footer: z.object({ text: z.string().max(2048), icon_url: z.url().optional() }).optional(),
    image: z.object({ url: z.url() }).optional(),
    thumbnail: z.object({ url: z.url() }).optional(),
    fields: z
      .array(
        z.object({
          name: z.string().max(256),
          value: z.string().max(1024),
          inline: z.boolean().optional(),
        }),
      )
      .max(25)
      .optional(),
  })
  .describe("A rich embed. At least one of title, description or fields should be set.");

export type EmbedInput = z.infer<typeof embedSchema>;

/** Converts our friendlier embed input into Discord's wire format. */
export function toApiEmbed(embed: EmbedInput): Record<string, unknown> {
  const { color, ...rest } = embed;
  if (color === undefined) return { ...rest };
  return {
    ...rest,
    color: typeof color === "number" ? color : Number.parseInt(color.replace("#", ""), 16),
  };
}

/**
 * Discord's default is to ping every user and role named in the text. That is
 * the wrong default for an agent, so mentions are suppressed unless asked for.
 */
export const allowMentions = z
  .boolean()
  .default(false)
  .describe("Whether @mentions in the content actually ping people. Defaults to false to avoid accidental pings.");

export function mentionPolicy(allow: boolean): Record<string, unknown> {
  return allow ? { parse: ["users", "roles", "everyone"] } : { parse: [] };
}
