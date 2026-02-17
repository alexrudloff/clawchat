/**
 * OpenClaw ClawChat Channel Plugin
 *
 * Registers ClawChat as a native messaging channel in OpenClaw,
 * enabling P2P encrypted agent-to-agent messaging via the
 * OpenClaw binding system.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { clawChatPlugin } from "./src/channel.js";
import { setClawChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "clawchat",
  name: "ClawChat",
  description: "P2P encrypted agent-to-agent messaging via ClawChat",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setClawChatRuntime(api.runtime);
    api.registerChannel({ plugin: clawChatPlugin });
  },
};

export default plugin;
