/**
 * Clawchat Daemon Server
 *
 * Provides:
 * - libp2p-based P2P networking with NAT traversal
 * - SNaP2P authentication layer
 * - PX-1 peer exchange for mesh connectivity
 * - IPC interface for CLI commands
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { randomBytes } from '@noble/hashes/utils';
import { getDataDir, type FullIdentity } from '../identity/keys.js';
import type { Message, Peer } from '../types.js';
import {
  createLibP2PNode,
  stopLibP2PNode,
  getMultiaddrs,
  type LibP2PNode,
} from '../net/libp2p-node.js';
import { Snap2pSession, Snap2pProtocolHandler } from '../net/snap2p-protocol.js';
import { PX1Handler } from '../net/px1.js';
import { PeerVisibility, type PeerAddressInfo } from '../types/px1.js';

const SOCKET_NAME = 'clawchat.sock';
const PID_FILE = 'daemon.pid';
const INBOX_FILE = 'inbox.json';
const OUTBOX_FILE = 'outbox.json';
const PEERS_FILE = 'peers.json';

export interface DaemonConfig {
  identity: FullIdentity;
  p2pPort: number;
  bootstrapNodes?: string[];
  enableRelay?: boolean;
  enableRelayServer?: boolean;
  openclawWake?: boolean;  // Enable openclaw wake on message receipt
}

// IPC command types
export type IpcCommand =
  | { cmd: 'send'; to: string; content: string }
  | { cmd: 'recv'; since?: number; timeout?: number }
  | { cmd: 'inbox' }
  | { cmd: 'outbox' }
  | { cmd: 'peers' }
  | { cmd: 'peer_add'; principal: string; address: string; alias?: string }
  | { cmd: 'peer_remove'; principal: string }
  | { cmd: 'peer_resolve'; principal: string; through?: string }
  | { cmd: 'status' }
  | { cmd: 'multiaddrs' }
  | { cmd: 'connect'; multiaddr: string }
  | { cmd: 'stop' };

export interface IpcResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export class Daemon extends EventEmitter {
  private identity: FullIdentity;
  private p2pPort: number;
  private config: DaemonConfig;
  private libp2pNode: LibP2PNode | null = null;
  private snap2pHandler: Snap2pProtocolHandler | null = null;
  private px1Handler: PX1Handler | null = null;
  private ipcServer: net.Server | null = null;
  private sessions: Map<string, Snap2pSession> = new Map();
  private inbox: Message[] = [];
  private outbox: Message[] = [];
  private peers: Peer[] = [];
  private dataDir: string;

  constructor(config: DaemonConfig) {
    super();
    this.identity = config.identity;
    this.p2pPort = config.p2pPort;
    this.config = config;
    this.dataDir = getDataDir();
    this.loadState();
  }

  private loadState(): void {
    // Load inbox
    const inboxPath = path.join(this.dataDir, INBOX_FILE);
    if (fs.existsSync(inboxPath)) {
      this.inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf-8'));
    }

    // Load outbox
    const outboxPath = path.join(this.dataDir, OUTBOX_FILE);
    if (fs.existsSync(outboxPath)) {
      this.outbox = JSON.parse(fs.readFileSync(outboxPath, 'utf-8'));
    }

    // Load peers
    const peersPath = path.join(this.dataDir, PEERS_FILE);
    if (fs.existsSync(peersPath)) {
      this.peers = JSON.parse(fs.readFileSync(peersPath, 'utf-8'));
    }
  }

  private saveInbox(): void {
    fs.writeFileSync(
      path.join(this.dataDir, INBOX_FILE),
      JSON.stringify(this.inbox, null, 2)
    );
  }

  private saveOutbox(): void {
    fs.writeFileSync(
      path.join(this.dataDir, OUTBOX_FILE),
      JSON.stringify(this.outbox, null, 2)
    );
  }

  private savePeers(): void {
    fs.writeFileSync(
      path.join(this.dataDir, PEERS_FILE),
      JSON.stringify(this.peers, null, 2)
    );
  }

  async start(): Promise<void> {
    // Write PID file
    fs.writeFileSync(
      path.join(this.dataDir, PID_FILE),
      process.pid.toString()
    );

    // Create libp2p node
    this.libp2pNode = await createLibP2PNode({
      identity: this.identity,
      listenAddrs: [
        `/ip4/0.0.0.0/tcp/${this.p2pPort}`,
        `/ip4/0.0.0.0/tcp/${this.p2pPort + 1}/ws`,
      ],
      bootstrapNodes: this.config.bootstrapNodes,
      enableRelay: this.config.enableRelay,
      enableRelayServer: this.config.enableRelayServer,
    });

    // Set up SNaP2P protocol handler
    this.snap2pHandler = new Snap2pProtocolHandler(
      this.libp2pNode.node,
      this.identity
    );

    this.snap2pHandler.on('session', (session: Snap2pSession) => {
      this.handleSession(session);
    });

    this.snap2pHandler.on('message', (msg, session) => {
      this.handleMessage(msg, session);
    });

    this.snap2pHandler.on('session:close', (session: Snap2pSession) => {
      if (session.remote) {
        this.sessions.delete(session.remote);
        this.emit('p2p:disconnected', session.remote);
      }
    });

    this.snap2pHandler.start();

    // Set up PX-1 peer exchange
    this.px1Handler = new PX1Handler(
      this.libp2pNode.node,
      this.identity.principal
    );

    this.px1Handler.on('peers:received', (peers: PeerAddressInfo[]) => {
      this.handleReceivedPeers(peers);
    });

    this.px1Handler.start();

    // Start IPC server (unix socket)
    const socketPath = path.join(this.dataDir, SOCKET_NAME);

    // Remove stale socket
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    this.ipcServer = net.createServer((socket) => {
      this.handleIpcConnection(socket);
    });

    this.ipcServer.listen(socketPath);

    // Process outbox periodically
    setInterval(() => this.processOutbox(), 5000);

    // Push peers to connected nodes periodically
    setInterval(() => this.pushPeersToConnected(), 60000);

    const multiaddrs = getMultiaddrs(this.libp2pNode);

    this.emit('started', {
      p2pPort: this.p2pPort,
      ipcSocket: socketPath,
      principal: this.identity.principal,
      peerId: this.libp2pNode.peerId,
      multiaddrs,
    });
  }

  private handleSession(session: Snap2pSession): void {
    const remote = session.remote;
    if (!remote) return;

    this.sessions.set(remote, session);

    // Update peer lastSeen and add peerId if we have it
    const peer = this.peers.find(p => p.principal === remote);
    if (peer) {
      peer.lastSeen = Date.now();
      // Store the multiaddrs if available
      if (session.peerId) {
        // The address field now stores multiaddrs
        const existingAddrs = peer.address ? peer.address.split(',') : [];
        const currentAddrs = this.libp2pNode?.node.getConnections()
          .filter(c => c.remotePeer.toString() === session.peerId)
          .map(c => c.remoteAddr.toString()) ?? [];

        if (currentAddrs.length > 0) {
          const allAddrs = [...new Set([...existingAddrs, ...currentAddrs])];
          peer.address = allAddrs.join(',');
        }
      }
      this.savePeers();

      // Add to PX-1 cache as verified
      if (this.px1Handler && session.peerId) {
        const multiaddrs = peer.address?.split(',') ?? [];
        this.px1Handler.addVerifiedPeer(remote, session.peerId, multiaddrs);
      }
    }

    this.emit('p2p:connected', remote);

    // Push our known peers to the new connection
    this.pushPeersToSession(session);
  }

  private handleMessage(msg: { id: string; from: string; nick?: string; content: string; timestamp: number }, session: Snap2pSession): void {
    const message: Message = {
      id: msg.id,
      from: msg.from,
      fromNick: msg.nick,
      to: this.identity.principal,
      content: msg.content,
      timestamp: msg.timestamp,
      status: 'delivered',
    };

    this.inbox.push(message);
    this.saveInbox();

    this.emit('message', message);

    // Trigger openclaw wake if enabled
    if (this.config.openclawWake) {
      this.triggerOpenclawWake(message);
    }
  }

  private triggerOpenclawWake(message: Message): void {
    try {
      const { spawnSync } = require('child_process');

      // Determine priority based on message content
      const isUrgent = message.content.startsWith('URGENT:') ||
                      message.content.startsWith('ALERT:') ||
                      message.content.startsWith('CRITICAL:');

      const mode = isUrgent ? 'now' : 'next-heartbeat';

      // Format message for openclaw
      const fromDisplay = message.fromNick
        ? `${message.from}(${message.fromNick})`
        : message.from;

      const wakeMessage = `ClawChat from ${fromDisplay}: ${message.content}`;

      // Spawn openclaw wake command
      // Use spawnSync with timeout to avoid blocking
      const result = spawnSync('openclaw', ['wake', wakeMessage, '--mode', mode], {
        timeout: 5000,  // 5 second timeout
        stdio: 'ignore'  // Don't capture output
      });

      // Log error if command failed (but don't crash daemon)
      if (result.error) {
        console.error('[openclaw-wake] Failed to trigger wake:', result.error.message);
      }
    } catch (error) {
      // Silent fail - openclaw might not be installed or available
      console.error('[openclaw-wake] Error triggering wake:', error);
    }
  }

  private handleReceivedPeers(peers: PeerAddressInfo[]): void {
    for (const peerInfo of peers) {
      // Don't add ourselves
      if (peerInfo.principal === this.identity.principal) continue;

      const existing = this.peers.find(p => p.principal === peerInfo.principal);
      if (existing) {
        // Merge multiaddrs
        const existingAddrs = existing.address?.split(',') ?? [];
        const newAddrs = [...new Set([...existingAddrs, ...peerInfo.multiaddrs])];
        existing.address = newAddrs.join(',');
        existing.lastSeen = Math.max(existing.lastSeen ?? 0, peerInfo.lastSeen);
      } else {
        // Add new peer
        this.peers.push({
          principal: peerInfo.principal,
          address: peerInfo.multiaddrs.join(','),
          lastSeen: peerInfo.lastSeen,
        });
      }
    }

    this.savePeers();
    this.emit('peers:discovered', peers);
  }

  private async pushPeersToSession(session: Snap2pSession): Promise<void> {
    if (!this.px1Handler || !session.peerId) return;

    try {
      await this.px1Handler.pushPeers(session.peerId);
    } catch (err) {
      console.error('Failed to push peers:', err);
    }
  }

  private async pushPeersToConnected(): Promise<void> {
    if (!this.px1Handler) return;

    for (const session of this.sessions.values()) {
      await this.pushPeersToSession(session);
    }
  }

  private handleIpcConnection(socket: net.Socket): void {
    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString();

      // Simple newline-delimited JSON protocol
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const cmd = JSON.parse(line) as IpcCommand;
          const response = await this.handleIpcCommand(cmd);
          socket.write(JSON.stringify(response) + '\n');
        } catch (err) {
          socket.write(JSON.stringify({
            ok: false,
            error: String(err),
          }) + '\n');
        }
      }
    });
  }

  /**
   * Execute an IPC command directly (useful for testing)
   */
  async executeCommand(cmd: IpcCommand): Promise<IpcResponse> {
    return this.handleIpcCommand(cmd);
  }

  private async handleIpcCommand(cmd: IpcCommand): Promise<IpcResponse> {
    switch (cmd.cmd) {
      case 'send': {
        const id = Buffer.from(randomBytes(16)).toString('hex');
        const message: Message = {
          id,
          from: this.identity.principal,
          to: cmd.to,
          content: cmd.content,
          timestamp: Date.now(),
          status: 'pending',
        };

        this.outbox.push(message);
        this.saveOutbox();

        // Try immediate delivery
        await this.tryDeliver(message);

        return { ok: true, data: { id, status: 'queued' } };
      }

      case 'recv': {
        const since = cmd.since || 0;
        const timeout = cmd.timeout;

        // If no timeout, return immediately
        if (!timeout || timeout <= 0) {
          const messages = this.inbox.filter(m => m.timestamp > since);
          return { ok: true, data: messages };
        }

        // Wait for messages with timeout
        return await this.recvWithTimeout(since, timeout);
      }

      case 'inbox':
        return { ok: true, data: this.inbox };

      case 'outbox':
        return { ok: true, data: this.outbox };

      case 'peers':
        return {
          ok: true,
          data: this.peers.map(p => ({
            ...p,
            connected: this.sessions.has(p.principal),
          })),
        };

      case 'peer_add': {
        const existing = this.peers.findIndex(p => p.principal === cmd.principal);
        const peer: Peer = {
          principal: cmd.principal,
          address: cmd.address, // Can be multiaddr or host:port
          alias: cmd.alias,
          lastSeen: Date.now(),
        };

        if (existing >= 0) {
          this.peers[existing] = peer;
        } else {
          this.peers.push(peer);
        }
        this.savePeers();

        return { ok: true, data: peer };
      }

      case 'peer_remove': {
        this.peers = this.peers.filter(p => p.principal !== cmd.principal);
        this.savePeers();
        return { ok: true };
      }

      case 'peer_resolve': {
        if (!this.px1Handler) {
          return { ok: false, error: 'PX-1 not initialized' };
        }

        // If through is specified, ask that peer
        // Otherwise, check our local cache
        const through = cmd.through;
        if (through) {
          const session = this.sessions.get(through);
          if (!session?.peerId) {
            return { ok: false, error: 'Not connected to relay peer' };
          }
          const result = await this.px1Handler.resolve(cmd.principal, session.peerId);
          return { ok: true, data: result };
        } else {
          const cached = this.px1Handler.getPeer(cmd.principal);
          return { ok: true, data: cached };
        }
      }

      case 'status':
        return {
          ok: true,
          data: {
            principal: this.identity.principal,
            peerId: this.libp2pNode?.peerId,
            p2pPort: this.p2pPort,
            multiaddrs: this.libp2pNode ? getMultiaddrs(this.libp2pNode) : [],
            connectedPeers: Array.from(this.sessions.keys()),
            inboxCount: this.inbox.length,
            outboxCount: this.outbox.filter(m => m.status === 'pending').length,
          },
        };

      case 'multiaddrs':
        return {
          ok: true,
          data: this.libp2pNode ? getMultiaddrs(this.libp2pNode) : [],
        };

      case 'connect': {
        try {
          if (!this.libp2pNode) {
            return { ok: false, error: 'libp2p not initialized' };
          }

          const { multiaddr } = await import('@multiformats/multiaddr');
          const ma = multiaddr(cmd.multiaddr);
          await this.libp2pNode.node.dial(ma);

          // Extract peer ID from multiaddr if present
          const peerIdStr = ma.getPeerId();
          if (peerIdStr && this.snap2pHandler) {
            // Open SNaP2P stream for authentication
            const session = await this.snap2pHandler.connect(peerIdStr);
            return { ok: true, data: { connected: true, principal: session.remote } };
          }

          return { ok: true, data: { connected: true } };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      }

      case 'stop':
        await this.stop();
        return { ok: true, data: { status: 'stopping' } };

      default:
        return { ok: false, error: 'Unknown command' };
    }
  }

  /**
   * Wait for messages with a timeout
   * Returns all messages received since `since` timestamp, waiting up to `timeout` ms
   */
  private async recvWithTimeout(since: number, timeout: number): Promise<IpcResponse> {
    const startTime = Date.now();
    const endTime = startTime + timeout;

    // Collect messages that arrive during the timeout period
    const collectedMessages: Message[] = [];

    // Get any existing messages first
    const existingMessages = this.inbox.filter(m => m.timestamp > since);
    collectedMessages.push(...existingMessages);

    // If we already have messages, we could return immediately
    // But the user wants to wait for the full timeout to catch ACKs, etc.
    // So we'll wait and collect any new messages that arrive

    return new Promise((resolve) => {
      const messageHandler = (msg: Message) => {
        if (msg.timestamp > since) {
          collectedMessages.push(msg);
        }
      };

      this.on('message', messageHandler);

      const checkAndResolve = () => {
        this.off('message', messageHandler);
        // Return unique messages (dedupe by id)
        const uniqueMessages = Array.from(
          new Map(collectedMessages.map(m => [m.id, m])).values()
        );
        resolve({ ok: true, data: uniqueMessages });
      };

      // Set timeout to resolve
      setTimeout(checkAndResolve, timeout);
    });
  }

  private async tryDeliver(message: Message): Promise<boolean> {
    // Check if we have an active session
    let session = this.sessions.get(message.to);

    if (session && session.isAuthenticated) {
      try {
        await session.sendChatMessage(message.content);
        message.status = 'sent';
        this.saveOutbox();
        return true;
      } catch {
        // Session might be stale, remove it
        this.sessions.delete(message.to);
      }
    }

    // Try to connect to the peer
    const peer = this.peers.find(p => p.principal === message.to);
    if (!peer?.address) {
      // Try PX-1 resolution through connected peers
      if (this.px1Handler && this.sessions.size > 0) {
        for (const connectedSession of this.sessions.values()) {
          if (connectedSession.peerId) {
            const resolved = await this.px1Handler.resolve(message.to, connectedSession.peerId);
            if (resolved && resolved.multiaddrs.length > 0) {
              // Try to connect via resolved addresses
              for (const addr of resolved.multiaddrs) {
                const connected = await this.tryConnect(addr);
                if (connected) {
                  session = this.sessions.get(message.to);
                  if (session?.isAuthenticated) {
                    try {
                      await session.sendChatMessage(message.content);
                      message.status = 'sent';
                      this.saveOutbox();
                      return true;
                    } catch {
                      // Continue trying
                    }
                  }
                }
              }
            }
          }
        }
      }
      return false;
    }

    // Try each address (comma-separated multiaddrs)
    const addresses = peer.address.split(',');
    for (const addr of addresses) {
      const connected = await this.tryConnect(addr.trim());
      if (connected) {
        session = this.sessions.get(message.to);
        if (session?.isAuthenticated) {
          try {
            await session.sendChatMessage(message.content);
            message.status = 'sent';
            this.saveOutbox();
            return true;
          } catch {
            // Continue trying
          }
        }
      }
    }

    return false;
  }

  private async tryConnect(address: string): Promise<boolean> {
    if (!this.libp2pNode || !this.snap2pHandler) return false;

    try {
      // Check if it's a multiaddr or legacy host:port
      if (address.startsWith('/')) {
        // It's a multiaddr
        const { multiaddr } = await import('@multiformats/multiaddr');
        const ma = multiaddr(address);
        await this.libp2pNode.node.dial(ma);

        const peerIdStr = ma.getPeerId();
        if (peerIdStr) {
          await this.snap2pHandler.connect(peerIdStr);
          return true;
        }
      } else if (address.includes(':')) {
        // Legacy host:port format - convert to multiaddr
        const [host, port] = address.split(':');
        const ma = `/ip4/${host}/tcp/${port}`;
        const { multiaddr } = await import('@multiformats/multiaddr');
        await this.libp2pNode.node.dial(multiaddr(ma));
        return true;
      }
    } catch (err) {
      console.error(`Failed to connect to ${address}:`, err);
    }

    return false;
  }

  private async processOutbox(): Promise<void> {
    const pending = this.outbox.filter(m => m.status === 'pending');

    for (const message of pending) {
      await this.tryDeliver(message);
    }
  }

  async stop(exitProcess = true): Promise<void> {
    // Stop PX-1 handler
    if (this.px1Handler) {
      this.px1Handler.stop();
    }

    // Stop SNaP2P handler
    if (this.snap2pHandler) {
      this.snap2pHandler.stop();
    }

    // Stop libp2p node
    if (this.libp2pNode) {
      await stopLibP2PNode(this.libp2pNode);
    }

    // Close IPC server
    if (this.ipcServer) {
      this.ipcServer.close();
    }

    // Close all sessions
    for (const session of this.sessions.values()) {
      session.close();
    }

    // Remove socket and PID file
    const socketPath = path.join(this.dataDir, SOCKET_NAME);
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    const pidPath = path.join(this.dataDir, PID_FILE);
    if (fs.existsSync(pidPath)) {
      fs.unlinkSync(pidPath);
    }

    this.emit('stopped');
    if (exitProcess) {
      process.exit(0);
    }
  }
}

// Check if daemon is running
export function isDaemonRunning(): boolean {
  const dataDir = getDataDir();
  const pidPath = path.join(dataDir, PID_FILE);

  if (!fs.existsSync(pidPath)) {
    return false;
  }

  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8'), 10);

  try {
    process.kill(pid, 0); // Check if process exists
    return true;
  } catch {
    // Process doesn't exist, clean up stale PID file
    fs.unlinkSync(pidPath);
    return false;
  }
}

// IPC client for CLI
export class IpcClient {
  private socketPath: string;

  constructor() {
    this.socketPath = path.join(getDataDir(), SOCKET_NAME);
  }

  async send(cmd: IpcCommand, socketTimeoutMs?: number): Promise<IpcResponse> {
    // If the command has a timeout (like recv with --timeout), extend socket timeout
    const cmdTimeout = 'timeout' in cmd && typeof cmd.timeout === 'number' ? cmd.timeout : 0;
    const timeout = socketTimeoutMs ?? Math.max(5000, cmdTimeout + 2000); // Add 2s buffer

    return new Promise((resolve, reject) => {
      if (!fs.existsSync(this.socketPath)) {
        reject(new Error('Daemon not running. Start with: clawchat daemon start'));
        return;
      }

      const socket = net.createConnection(this.socketPath);
      let response = '';

      socket.on('connect', () => {
        socket.write(JSON.stringify(cmd) + '\n');
      });

      socket.on('data', (data) => {
        response += data.toString();
        if (response.includes('\n')) {
          socket.end();
          resolve(JSON.parse(response.trim()));
        }
      });

      socket.on('error', reject);

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      });

      socket.setTimeout(timeout);
    });
  }
}
