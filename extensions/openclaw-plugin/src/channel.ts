/**
 * ClawChat ChannelPlugin implementation for OpenClaw.
 *
 * Provides P2P encrypted agent-to-agent messaging as a native
 * OpenClaw channel, with full support for DM policy, pairing,
 * inbound monitoring, and outbound delivery.
 */

import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
  applyAccountNameToChannelSection,
} from "openclaw/plugin-sdk";
import {
  listClawChatAccountIds,
  type ResolvedClawChatAccount,
  resolveClawChatAccount,
  resolveDefaultClawChatAccountId,
} from "./accounts.js";
import { ClawChatConfigSchema } from "./config-schema.js";
import { sendClawChatMessage } from "./send.js";
import { monitorClawChat } from "./monitor.js";
import { isDaemonRunning, sendIpcCommand } from "./ipc.js";
import {
  normalizeClawChatPrincipal,
  normalizeClawChatMessagingTarget,
  looksLikeClawChatTargetId,
} from "./targets.js";
import type { ClawChatDaemonStatus } from "./types.js";

const meta = {
  id: "clawchat",
  label: "ClawChat",
  selectionLabel: "ClawChat (P2P)",
  detailLabel: "ClawChat P2P",
  docsPath: "/channels/clawchat",
  docsLabel: "clawchat",
  blurb: "P2P encrypted agent-to-agent messaging via ClawChat.",
  systemImage: "lock.shield",
  aliases: ["cc", "p2p"],
  order: 90,
};

export const clawChatPlugin: ChannelPlugin<ResolvedClawChatAccount> = {
  id: "clawchat",
  meta,
  capabilities: {
    chatTypes: ["direct"],
  },
  reload: { configPrefixes: ["channels.clawchat"] },
  configSchema: buildChannelConfigSchema(ClawChatConfigSchema),
  config: {
    listAccountIds: (cfg) => listClawChatAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      resolveClawChatAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultClawChatAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "clawchat",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "clawchat",
        accountId,
        clearBaseFields: ["principal", "password", "passwordFile", "name", "dataDir"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.principal, // Use baseUrl field to hold the principal for display
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveClawChatAccount({ cfg, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^clawchat:/i, ""))
        .map((entry) => normalizeClawChatPrincipal(entry)),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId =
        accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const section = (cfg.channels as Record<string, unknown>)
        ?.clawchat as Record<string, unknown> | undefined;
      const useAccountPath = Boolean(
        (section?.accounts as Record<string, unknown>)?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.clawchat.accounts.${resolvedAccountId}.`
        : "channels.clawchat.";
      return {
        policy: account.config.dmPolicy ?? "allowlist",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("clawchat"),
        normalizeEntry: (raw: string) =>
          normalizeClawChatPrincipal(raw.replace(/^clawchat:/i, "")),
      };
    },
  },
  messaging: {
    normalizeTarget: normalizeClawChatMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeClawChatTargetId,
      hint: "<principal>  (e.g., stacks:ST1ABC... or local:abc123...)",
    },
    formatTargetDisplay: ({ target, display }) => {
      const trimmedDisplay = display?.trim();
      if (trimmedDisplay && !looksLikeClawChatTargetId(trimmedDisplay)) {
        return trimmedDisplay;
      }
      const principal = normalizeClawChatPrincipal(
        target?.trim() || display?.trim() || "",
      );
      if (!principal) {
        return display?.trim() || target?.trim() || "";
      }
      // Truncate long principals for display
      if (principal.length > 30) {
        return `${principal.slice(0, 12)}...${principal.slice(-8)}`;
      }
      return principal;
    },
  },
  pairing: {
    idLabel: "clawchatSenderId",
    normalizeAllowEntry: (entry) =>
      normalizeClawChatPrincipal(entry.replace(/^clawchat:/i, "")),
    notifyApproval: async ({ cfg, id }) => {
      await sendClawChatMessage(id, PAIRING_APPROVED_MESSAGE, { cfg });
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error(
            "Delivering to ClawChat requires --to <principal>",
          ),
        };
      }
      const normalized = normalizeClawChatPrincipal(trimmed);
      if (!normalized) {
        return {
          ok: false,
          error: new Error(
            `Invalid ClawChat target: ${trimmed}`,
          ),
        };
      }
      return { ok: true, to: normalized };
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const result = await sendClawChatMessage(to, text, {
        cfg,
        accountId: accountId ?? undefined,
      });
      return { channel: "clawchat", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      principal: snapshot.baseUrl ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      try {
        if (!isDaemonRunning(account.dataDir)) {
          return { ok: false, error: "daemon not running" };
        }
        const response = await sendIpcCommand(
          { cmd: "status", as: account.principal || undefined },
          { dataDir: account.dataDir, timeoutMs: timeoutMs ?? 5000 },
        );
        if (!response.ok) {
          return { ok: false, error: response.error ?? "status check failed" };
        }
        const status = response.data as ClawChatDaemonStatus;
        return {
          ok: true,
          principal: status.principal,
          connectedPeers: status.connectedPeers.length,
          inboxCount: status.inboxCount,
          loadedIdentities: status.loadedIdentities.length,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const running = runtime?.running ?? false;
      const probeOk = (probe as { ok?: boolean } | undefined)?.ok;
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        baseUrl: account.principal,
        running,
        connected: probeOk ?? running,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.principal, // Store principal in baseUrl for status display
      });
      ctx.log?.info(
        `[${account.accountId}] starting ClawChat monitor (principal=${account.principal ?? "default"})`,
      );
      return monitorClawChat({
        account,
        config: ctx.cfg,
        runtime: {
          log: ctx.runtime.log,
          error: ctx.runtime.error,
        },
        abortSignal: ctx.abortSignal,
        statusSink: (patch) =>
          ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
