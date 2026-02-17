/**
 * Account resolution for ClawChat channel plugin.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { ClawChatAccountConfig } from "./types.js";

export type ResolvedClawChatAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: ClawChatAccountConfig;
  configured: boolean;
  /** The principal this account sends as. */
  principal?: string;
  /** Data directory for this account. */
  dataDir: string;
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels as Record<string, unknown> | undefined)?.clawchat as
    | Record<string, unknown>
    | undefined;
  const accts = accounts?.accounts;
  if (!accts || typeof accts !== "object") {
    return [];
  }
  return Object.keys(accts as Record<string, unknown>).filter(Boolean);
}

export function listClawChatAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultClawChatAccountId(cfg: OpenClawConfig): string {
  const ids = listClawChatAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function getChannelSection(cfg: OpenClawConfig): Record<string, unknown> {
  return ((cfg.channels as Record<string, unknown> | undefined)?.clawchat ?? {}) as Record<
    string,
    unknown
  >;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ClawChatAccountConfig | undefined {
  const section = getChannelSection(cfg);
  const accounts = section.accounts as Record<string, ClawChatAccountConfig> | undefined;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

function mergeClawChatAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ClawChatAccountConfig {
  const base = getChannelSection(cfg) as ClawChatAccountConfig & { accounts?: unknown };
  const { accounts: _ignored, ...rest } = base;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...rest, ...account };
}

export function resolveClawChatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedClawChatAccount {
  const accountId = normalizeAccountId(params.accountId);
  const section = getChannelSection(params.cfg);
  const baseEnabled = (section as { enabled?: boolean }).enabled;
  const merged = mergeClawChatAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const principal = merged.principal?.trim();
  const hasPassword = Boolean(merged.password?.trim() || merged.passwordFile?.trim());
  const configured = Boolean(principal || hasPassword);
  const dataDir = merged.dataDir?.trim() || "~/.clawchat";

  return {
    accountId,
    enabled: baseEnabled !== false && accountEnabled,
    name: merged.name?.trim() || undefined,
    config: merged,
    configured,
    principal,
    dataDir,
  };
}
