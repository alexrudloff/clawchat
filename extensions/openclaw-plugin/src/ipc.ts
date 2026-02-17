/**
 * IPC client for communicating with the ClawChat daemon via Unix socket.
 *
 * Protocol: newline-delimited JSON over a Unix domain socket
 * at <dataDir>/clawchat.sock.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ClawChatIpcCommand, ClawChatIpcResponse } from "./types.js";

const SOCKET_NAME = "clawchat.sock";
const PID_FILE = "daemon.pid";

function resolveDataDir(dataDir?: string): string {
  const raw = dataDir?.trim() || "~/.clawchat";
  if (raw.startsWith("~")) {
    return path.join(os.homedir(), raw.slice(1));
  }
  return raw;
}

/**
 * Check if the ClawChat daemon is running.
 */
export function isDaemonRunning(dataDir?: string): boolean {
  const dir = resolveDataDir(dataDir);
  const pidPath = path.join(dir, PID_FILE);

  if (!fs.existsSync(pidPath)) {
    return false;
  }

  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
    process.kill(pid, 0); // Check if process exists
    return true;
  } catch {
    return false;
  }
}

/**
 * Send an IPC command to the ClawChat daemon and receive a response.
 */
export async function sendIpcCommand(
  cmd: ClawChatIpcCommand,
  options?: {
    dataDir?: string;
    timeoutMs?: number;
  },
): Promise<ClawChatIpcResponse> {
  const dir = resolveDataDir(options?.dataDir);
  const socketPath = path.join(dir, SOCKET_NAME);

  // For recv commands with timeout, extend the socket timeout accordingly
  const cmdTimeout =
    "timeout" in cmd && typeof cmd.timeout === "number" ? cmd.timeout : 0;
  const timeout = options?.timeoutMs ?? Math.max(5000, cmdTimeout + 2000);

  return new Promise((resolve, reject) => {
    if (!fs.existsSync(socketPath)) {
      reject(
        new Error(
          "ClawChat daemon not running. Start with: clawchat daemon start",
        ),
      );
      return;
    }

    const socket = net.createConnection(socketPath);
    let response = "";

    socket.on("connect", () => {
      socket.write(JSON.stringify(cmd) + "\n");
    });

    socket.on("data", (data) => {
      response += data.toString();
      if (response.includes("\n")) {
        socket.end();
        try {
          resolve(JSON.parse(response.trim()) as ClawChatIpcResponse);
        } catch (err) {
          reject(new Error(`Invalid IPC response: ${response.trim()}`));
        }
      }
    });

    socket.on("error", (err) => {
      reject(new Error(`ClawChat IPC error: ${err.message}`));
    });

    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("ClawChat IPC timeout"));
    });

    socket.setTimeout(timeout);
  });
}
