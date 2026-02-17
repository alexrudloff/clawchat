/**
 * Inbound message monitoring for ClawChat channel plugin.
 *
 * Polls the ClawChat daemon IPC for new messages and dispatches
 * them into OpenClaw's inbound message pipeline.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedClawChatAccount } from "./accounts.js";
import type { ClawChatMessage } from "./types.js";
import { sendIpcCommand, isDaemonRunning } from "./ipc.js";
import { isAllowedClawChatSender, normalizeClawChatPrincipal } from "./targets.js";
import { sendClawChatMessage } from "./send.js";
import { getClawChatRuntime } from "./runtime.js";

const DEFAULT_POLL_INTERVAL_MS = 3000;

export interface ClawChatMonitorEnv {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface ClawChatMonitorOptions {
  account: ResolvedClawChatAccount;
  config: OpenClawConfig;
  runtime: ClawChatMonitorEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: {
    running?: boolean;
    lastInboundAt?: number;
    lastError?: string | null;
  }) => void;
}

/**
 * Start monitoring for inbound ClawChat messages.
 *
 * Uses IPC `recv --since <ts> --timeout <ms>` for long-polling.
 * Falls back to regular polling if long-poll is unavailable.
 */
export async function monitorClawChat(
  options: ClawChatMonitorOptions,
): Promise<void> {
  const { account, config, runtime, abortSignal, statusSink } = options;
  const pollIntervalMs =
    account.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let lastTimestamp = Date.now();

  statusSink?.({ running: true, lastError: null });
  runtime.log?.(
    `[clawchat] [${account.accountId}] starting monitor (principal=${account.principal ?? "default"}, poll=${pollIntervalMs}ms)`,
  );

  // Wait for daemon to be available
  if (!isDaemonRunning(account.dataDir)) {
    runtime.log?.(
      `[clawchat] [${account.accountId}] daemon not running, waiting...`,
    );
    while (!abortSignal.aborted) {
      await sleep(pollIntervalMs);
      if (isDaemonRunning(account.dataDir)) {
        runtime.log?.(
          `[clawchat] [${account.accountId}] daemon detected, starting poll loop`,
        );
        break;
      }
    }
  }

  // Main poll loop
  while (!abortSignal.aborted) {
    try {
      const response = await sendIpcCommand(
        {
          cmd: "recv",
          since: lastTimestamp,
          timeout: pollIntervalMs,
          as: account.principal || undefined,
        },
        {
          dataDir: account.dataDir,
          timeoutMs: pollIntervalMs + 5000,
        },
      );

      if (!response.ok) {
        const errMsg = response.error ?? "unknown error";
        runtime.error?.(
          `[clawchat] [${account.accountId}] recv failed: ${errMsg}`,
        );
        statusSink?.({ lastError: errMsg });
        await sleep(pollIntervalMs);
        continue;
      }

      const messages = (response.data ?? []) as ClawChatMessage[];

      for (const msg of messages) {
        // Skip our own outbound messages
        if (msg.from === account.principal) {
          continue;
        }

        // Update lastTimestamp to avoid re-processing
        if (msg.timestamp > lastTimestamp) {
          lastTimestamp = msg.timestamp;
        }

        statusSink?.({ lastInboundAt: Date.now(), lastError: null });

        // Process the message through OpenClaw's inbound pipeline
        await processInboundMessage(msg, {
          account,
          config,
          runtime,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // If daemon went away, wait for it to come back
      if (
        errMsg.includes("not running") ||
        errMsg.includes("ENOENT") ||
        errMsg.includes("ECONNREFUSED")
      ) {
        runtime.log?.(
          `[clawchat] [${account.accountId}] daemon disconnected, waiting for reconnect...`,
        );
        statusSink?.({ running: false, lastError: "daemon not running" });

        while (!abortSignal.aborted) {
          await sleep(pollIntervalMs * 2);
          if (isDaemonRunning(account.dataDir)) {
            runtime.log?.(
              `[clawchat] [${account.accountId}] daemon reconnected`,
            );
            statusSink?.({ running: true, lastError: null });
            break;
          }
        }
        continue;
      }

      runtime.error?.(
        `[clawchat] [${account.accountId}] monitor error: ${errMsg}`,
      );
      statusSink?.({ lastError: errMsg });
      await sleep(pollIntervalMs);
    }
  }

  statusSink?.({ running: false });
  runtime.log?.(
    `[clawchat] [${account.accountId}] monitor stopped`,
  );
}

/**
 * Process a single inbound ClawChat message through OpenClaw's pipeline.
 */
async function processInboundMessage(
  msg: ClawChatMessage,
  ctx: {
    account: ResolvedClawChatAccount;
    config: OpenClawConfig;
    runtime: ClawChatMonitorEnv;
  },
): Promise<void> {
  const { account, config, runtime } = ctx;
  const core = getClawChatRuntime();

  const senderPrincipal = normalizeClawChatPrincipal(msg.from);
  if (!senderPrincipal) {
    return;
  }

  const text = msg.content.trim();
  if (!text) {
    return;
  }

  // Enforce DM policy
  const dmPolicy = account.config.dmPolicy ?? "allowlist";
  const configAllowFrom = (account.config.allowFrom ?? []).map((e) => String(e).trim()).filter(Boolean);
  const storeAllowFrom = await core.channel.pairing
    .readAllowFromStore("clawchat")
    .catch(() => []);
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom]
    .map((entry) => String(entry).trim())
    .filter(Boolean);

  if (dmPolicy === "disabled") {
    runtime.log?.(
      `[clawchat] blocked message from ${senderPrincipal} (dmPolicy=disabled)`,
    );
    return;
  }

  if (dmPolicy !== "open") {
    const allowed = isAllowedClawChatSender({
      allowFrom: effectiveAllowFrom,
      sender: senderPrincipal,
    });

    if (!allowed) {
      if (dmPolicy === "pairing") {
        // Issue a pairing request
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
          channel: "clawchat",
          id: senderPrincipal,
          meta: { name: msg.fromNick },
        });
        runtime.log?.(
          `[clawchat] pairing request sender=${senderPrincipal} created=${created}`,
        );
        if (created) {
          try {
            await sendClawChatMessage(
              senderPrincipal,
              core.channel.pairing.buildPairingReply({
                channel: "clawchat",
                idLine: `Your ClawChat principal: ${senderPrincipal}`,
                code,
              }),
              { cfg: config, accountId: account.accountId },
            );
          } catch (err) {
            runtime.error?.(
              `[clawchat] pairing reply failed: ${String(err)}`,
            );
          }
        }
      } else {
        runtime.log?.(
          `[clawchat] blocked message from ${senderPrincipal} (not in allowFrom)`,
        );
      }
      return;
    }
  }

  // Build session/routing info
  const peerId = senderPrincipal;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "clawchat",
    accountId: account.accountId,
    peer: { kind: "direct", id: peerId },
  });

  // Format the sender label
  const senderLabel = msg.fromNick
    ? `${msg.fromNick} (${senderPrincipal})`
    : senderPrincipal;
  const fromLabel = senderLabel;

  // Build the inbound envelope
  const storePath = core.channel.session.resolveStorePath(
    config.session?.store,
    { agentId: route.agentId },
  );
  const envelopeOptions =
    core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = core.channel.reply.formatInboundEnvelope({
    channel: "ClawChat",
    from: fromLabel,
    timestamp: msg.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: text,
    chatType: "direct",
    sender: {
      name: msg.fromNick || undefined,
      id: senderPrincipal,
    },
  });

  // Check for control commands
  const hasControlCmd = core.channel.text.hasControlCommand(text, config);
  const commandAuthorized = isAllowedClawChatSender({
    allowFrom: effectiveAllowFrom,
    sender: senderPrincipal,
  });

  const outboundTarget = senderPrincipal;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: text,
    RawBody: text,
    CommandBody: text,
    BodyForCommands: text,
    From: `clawchat:${senderPrincipal}`,
    To: `clawchat:${account.principal ?? "default"}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct" as const,
    ConversationLabel: fromLabel,
    SenderName: msg.fromNick || undefined,
    SenderId: senderPrincipal,
    Provider: "clawchat",
    Surface: "clawchat",
    MessageSid: msg.id,
    Timestamp: msg.timestamp,
    OriginatingChannel: "clawchat",
    OriginatingTo: `clawchat:${outboundTarget}`,
    WasMentioned: true, // Always true for DMs
    CommandAuthorized: commandAuthorized,
  });

  // Dispatch the reply
  const textLimit =
    account.config.textChunkLimit && account.config.textChunkLimit > 0
      ? account.config.textChunkLimit
      : 4000;

  try {
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      dispatcherOptions: {
        deliver: async (payload) => {
          const replyText = payload.text ?? "";
          if (!replyText.trim()) {
            return;
          }

          const chunks = core.channel.text.chunkMarkdownText(
            replyText,
            textLimit,
          );
          if (!chunks.length && replyText) {
            chunks.push(replyText);
          }

          for (const chunk of chunks) {
            await sendClawChatMessage(outboundTarget, chunk, {
              cfg: config,
              accountId: account.accountId,
            });
          }
        },
        onError: (err) => {
          runtime.error?.(
            `[clawchat] reply delivery failed: ${String(err)}`,
          );
        },
      },
    });
  } catch (err) {
    runtime.error?.(
      `[clawchat] dispatch failed for ${senderPrincipal}: ${String(err)}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
