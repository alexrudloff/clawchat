/**
 * Runtime singleton for the ClawChat plugin.
 *
 * The PluginRuntime is set during plugin registration and provides
 * access to OpenClaw's channel helpers (pairing, routing, reply, etc.).
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setClawChatRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getClawChatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("ClawChat runtime not initialized");
  }
  return runtime;
}
