import { z } from "zod";
import { ToolError } from "../lib/errors.js";

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
  .describe("Server name or ID. Optional if the bot is in one server or a default is set.");

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

/** Discord's cap on the text of all embeds in one message, added together. */
export const EMBED_TOTAL_LIMIT = 6000;

/** The characters Discord counts toward the per-message embed total. */
function embedTextLength(embed: EmbedInput): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.author?.name.length ?? 0) +
    (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

/**
 * A message's embeds, with the per-message total checked up front. Each embed can
 * pass its own limits while the set is still refused by Discord at send time.
 */
export const embedList = z
  .array(embedSchema)
  .max(10)
  .superRefine((embeds, ctx) => {
    const total = embeds.reduce((sum, embed) => sum + embedTextLength(embed), 0);
    if (total > EMBED_TOTAL_LIMIT) {
      ctx.addIssue({
        code: "custom",
        message:
          `Embeds total ${total} characters; Discord allows ${EMBED_TOTAL_LIMIT} across all embeds of one message. ` +
          "Shorten them or split them across messages.",
        input: embeds,
      });
    }
  });

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
 * the wrong default for an agent, so mentions are suppressed unless asked for,
 * and @everyone/@here - which can wake an entire server - need their own,
 * explicit opt-in on top of ordinary pings.
 */
export const allowMentions = z
  .union([z.boolean(), z.literal("everyone")])
  .default(false)
  .describe(
    "Whether @mentions in the content actually ping. false (default): nobody is pinged. true: mentioned users " +
      "and roles are pinged. 'everyone': @everyone and @here ping too.",
  );

export type MentionSetting = z.infer<typeof allowMentions>;

/**
 * The allowed_mentions body for a setting. @everyone/@here also need the
 * operator's DISCORD_ALLOW_MASS_MENTIONS, because the setting itself is chosen
 * by the agent, and so can be chosen for it by text it was asked to read.
 */
export function mentionPolicy(allow: MentionSetting, allowMass: boolean): Record<string, unknown> {
  if (allow === "everyone") {
    if (!allowMass) {
      throw new ToolError("Refused: pinging @everyone or @here is disabled.", {
        code: "MASS_MENTION_DISABLED",
        hint: "Use allow_mentions: true to ping named users and roles, or the operator can set DISCORD_ALLOW_MASS_MENTIONS=true.",
      });
    }
    return { parse: ["users", "roles", "everyone"], replied_user: true };
  }
  return allow ? { parse: ["users", "roles"], replied_user: true } : { parse: [], replied_user: false };
}
