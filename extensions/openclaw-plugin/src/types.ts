/**
 * ClawChat OpenClaw plugin type definitions.
 */

import type { DmPolicy } from "openclaw/plugin-sdk";

export type { DmPolicy } from "openclaw/plugin-sdk";

/**
 * Per-account configuration under channels.clawchat or channels.clawchat.accounts.<id>.
 */
export interface ClawChatAccountConfig {
  /** Optional display name for this account. */
  name?: string;
  /** If false, do not start this ClawChat account. Default: true. */
  enabled?: boolean;
  /** Path to the ClawChat data directory (default: ~/.clawchat). */
  dataDir?: string;
  /** ClawChat identity principal to use (if gateway hosts multiple identities). */
  principal?: string;
  /** Password for decrypting the ClawChat identity (or path via passwordFile). */
  password?: string;
  /** Path to a file containing the password (preferred over inline password). */
  passwordFile?: string;
  /** Direct message access policy (default: allowlist). */
  dmPolicy?: DmPolicy;
  /** Allowed sender principals. */
  allowFrom?: string[];
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Poll interval in ms for receiving messages (default: 3000). */
  pollIntervalMs?: number;
}

/**
 * Top-level config shape under channels.clawchat.
 */
export interface ClawChatConfig extends ClawChatAccountConfig {
  /** Optional per-account configuration (multi-account). */
  accounts?: Record<string, ClawChatAccountConfig>;
}

/**
 * A ClawChat message as returned by the daemon IPC.
 */
export interface ClawChatMessage {
  id: string;
  from: string;
  fromNick?: string;
  to: string;
  content: string;
  timestamp: number;
  status: "pending" | "sent" | "delivered" | "failed";
}

/**
 * Daemon status response.
 */
export interface ClawChatDaemonStatus {
  principal: string;
  peerId?: string;
  p2pPort: number;
  multiaddrs: string[];
  connectedPeers: string[];
  inboxCount: number;
  outboxCount: number;
  loadedIdentities: Array<{ principal: string; nick?: string }>;
}

/**
 * IPC command types (subset of what the daemon accepts).
 */
export type ClawChatIpcCommand =
  | { cmd: "send"; to: string; content: string; as?: string }
  | { cmd: "recv"; since?: number; timeout?: number; as?: string }
  | { cmd: "inbox"; as?: string }
  | { cmd: "status"; as?: string }
  | { cmd: "peers"; as?: string };

/**
 * IPC response from the daemon.
 */
export interface ClawChatIpcResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}
