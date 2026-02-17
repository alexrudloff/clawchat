/**
 * Target normalization for ClawChat principals.
 *
 * ClawChat principals are in the format:
 * - stacks:ST1ABC...   (Stacks mainnet)
 * - stacks:STXYZ...    (Stacks testnet)
 * - local:abc123...     (local-only identity)
 */

/**
 * Normalize a ClawChat principal for consistent comparison.
 */
export function normalizeClawChatPrincipal(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  // Strip optional "clawchat:" prefix
  const stripped = trimmed.replace(/^clawchat:/i, "").trim();
  if (!stripped) {
    return "";
  }
  return stripped;
}

/**
 * Check if a string looks like a ClawChat target ID.
 */
export function looksLikeClawChatTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.replace(/^clawchat:/i, "").trim();
  if (!normalized) {
    return false;
  }
  // Stacks principal: stacks:ST...
  if (/^stacks:ST[A-Z0-9]+$/i.test(normalized)) {
    return true;
  }
  // Local identity: local:<hex>
  if (/^local:[a-f0-9]+$/i.test(normalized)) {
    return true;
  }
  // Bare principal that looks like a Stacks address
  if (/^ST[A-Z0-9]{20,}$/i.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * Normalize a ClawChat messaging target (for routing).
 */
export function normalizeClawChatMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const principal = normalizeClawChatPrincipal(trimmed);
  if (!principal) {
    return undefined;
  }
  return principal;
}

/**
 * Check if a sender principal is in the allowFrom list.
 */
export function isAllowedClawChatSender(params: {
  allowFrom: string[];
  sender: string;
}): boolean {
  const { allowFrom, sender } = params;
  if (allowFrom.length === 0) {
    return true;
  }
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSender = normalizeClawChatPrincipal(sender);
  if (!normalizedSender) {
    return false;
  }
  for (const entry of allowFrom) {
    const normalizedEntry = normalizeClawChatPrincipal(entry);
    if (normalizedEntry === normalizedSender) {
      return true;
    }
  }
  return false;
}
