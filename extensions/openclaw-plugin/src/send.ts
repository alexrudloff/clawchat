/**
 * Outbound message sending for ClawChat channel plugin.
 *
 * Sends messages via the ClawChat daemon IPC socket.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveClawChatAccount } from "./accounts.js";
import { sendIpcCommand } from "./ipc.js";
import { normalizeClawChatPrincipal } from "./targets.js";

export interface ClawChatSendOpts {
  cfg?: OpenClawConfig;
  accountId?: string;
  timeoutMs?: number;
}

export interface ClawChatSendResult {
  messageId: string;
}

/**
 * Send a text message via ClawChat daemon IPC.
 */
export async function sendClawChatMessage(
  to: string,
  text: string,
  opts: ClawChatSendOpts = {},
): Promise<ClawChatSendResult> {
  const trimmedText = text?.trim();
  if (!trimmedText) {
    throw new Error("ClawChat send requires text");
  }

  const normalizedTo = normalizeClawChatPrincipal(to);
  if (!normalizedTo) {
    throw new Error("ClawChat send requires a valid recipient principal");
  }

  const account = resolveClawChatAccount({
    cfg: opts.cfg ?? ({} as OpenClawConfig),
    accountId: opts.accountId,
  });

  const response = await sendIpcCommand(
    {
      cmd: "send",
      to: normalizedTo,
      content: trimmedText,
      as: account.principal || undefined,
    },
    {
      dataDir: account.dataDir,
      timeoutMs: opts.timeoutMs,
    },
  );

  if (!response.ok) {
    throw new Error(`ClawChat send failed: ${response.error ?? "unknown error"}`);
  }

  const data = response.data as { id?: string; status?: string } | undefined;
  return { messageId: data?.id ?? "ok" };
}
