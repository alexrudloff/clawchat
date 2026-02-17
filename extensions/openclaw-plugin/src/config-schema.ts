/**
 * Zod schema for ClawChat channel configuration validation.
 */

import { z } from "zod";

const clawChatAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  dataDir: z.string().optional(),
  principal: z.string().optional(),
  password: z.string().optional(),
  passwordFile: z.string().optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  pollIntervalMs: z.number().int().positive().optional(),
});

export const ClawChatConfigSchema = clawChatAccountSchema.extend({
  accounts: z.object({}).catchall(clawChatAccountSchema).optional(),
});
