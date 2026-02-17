/**
 * WebSocket Bridge for ClawChat Web Frontend
 *
 * Provides a WebSocket server that bridges web clients to the ClawChat P2P mesh.
 * Web clients connect via standard WebSocket and the bridge proxies messages
 * bidirectionally between the web client and the daemon's P2P network.
 *
 * Protocol: JSON messages over WebSocket with type-based routing.
 *
 * Authentication: Token-based (configured in gateway-config.json).
 * Web clients must send an 'auth' message with a valid token before
 * they can interact with the mesh.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, createServer, type Server as HttpServer } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { Message, Peer } from '../types.js';

/**
 * WebSocket bridge configuration
 */
export interface WsBridgeConfig {
  /** Port for the WebSocket server (default: p2pPort + 100) */
  port: number;
  /** Authentication token (shared secret) */
  token?: string;
  /** Whether to serve the web UI static files */
  serveStatic?: boolean;
  /** Path to web UI static files directory */
  staticDir?: string;
}

/**
 * Incoming WS message types from web clients
 */
export type WsClientMessage =
  | { type: 'auth'; token: string; nickname?: string }
  | { type: 'send'; to: string; content: string; as?: string }
  | { type: 'inbox'; as?: string }
  | { type: 'outbox'; as?: string }
  | { type: 'peers'; as?: string }
  | { type: 'status'; as?: string }
  | { type: 'identities' }
  | { type: 'ping' };

/**
 * Outgoing WS message types to web clients
 */
export type WsServerMessage =
  | { type: 'auth_ok'; identities: Array<{ principal: string; nick?: string }> }
  | { type: 'auth_fail'; error: string }
  | { type: 'message'; message: Message }
  | { type: 'inbox'; messages: Message[] }
  | { type: 'outbox'; messages: Message[] }
  | { type: 'peers'; peers: Array<Peer & { connected: boolean }> }
  | { type: 'status'; data: Record<string, unknown> }
  | { type: 'identities'; identities: Array<{ principal: string; nick?: string }> }
  | { type: 'peer_connected'; principal: string }
  | { type: 'peer_disconnected'; principal: string }
  | { type: 'error'; error: string; requestType?: string }
  | { type: 'pong' };

/**
 * Connected web client state
 */
interface WebClient {
  ws: WebSocket;
  authenticated: boolean;
  nickname?: string;
  connectedAt: number;
}

/**
 * Command executor interface — the daemon implements this
 */
export interface CommandExecutor {
  executeCommand(cmd: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * WebSocket Bridge
 *
 * Bridges web clients to the ClawChat daemon via WebSocket.
 * The daemon must pass itself as the command executor.
 */
export class WsBridge extends EventEmitter {
  private config: WsBridgeConfig;
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private clients: Set<WebClient> = new Set();
  private executor: CommandExecutor;

  constructor(config: WsBridgeConfig, executor: CommandExecutor) {
    super();
    this.config = config;
    this.executor = executor;
  }

  /**
   * Start the WebSocket bridge server
   */
  async start(): Promise<void> {
    // Create HTTP server (for serving static files + WebSocket upgrade)
    this.httpServer = createServer((req, res) => {
      if (this.config.serveStatic && this.config.staticDir) {
        this.handleHttpRequest(req, res);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ClawChat WebSocket Bridge\n');
      }
    });

    // Create WebSocket server attached to HTTP server
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    // Listen for daemon events to broadcast to web clients
    this.executor.on('message', this.onDaemonMessage);
    this.executor.on('p2p:connected', this.onPeerConnected);
    this.executor.on('p2p:disconnected', this.onPeerDisconnected);

    // Start listening
    return new Promise((resolve, reject) => {
      this.httpServer!.listen(this.config.port, () => {
        console.log(`[ws-bridge] WebSocket bridge listening on port ${this.config.port}`);
        if (this.config.serveStatic) {
          console.log(`[ws-bridge] Web UI: http://localhost:${this.config.port}`);
        }
        resolve();
      });
      this.httpServer!.on('error', reject);
    });
  }

  /**
   * Stop the WebSocket bridge server
   */
  async stop(): Promise<void> {
    // Remove daemon event listeners
    this.executor.off('message', this.onDaemonMessage);
    this.executor.off('p2p:connected', this.onPeerConnected);
    this.executor.off('p2p:disconnected', this.onPeerDisconnected);

    // Close all client connections
    for (const client of this.clients) {
      client.ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer!.close(() => {
          this.httpServer = null;
          resolve();
        });
      });
    }
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const client: WebClient = {
      ws,
      authenticated: !this.config.token, // Auto-auth if no token configured
      connectedAt: Date.now(),
    };

    this.clients.add(client);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsClientMessage;
        this.handleClientMessage(client, msg);
      } catch (err) {
        this.sendToClient(client, {
          type: 'error',
          error: 'Invalid message format',
        });
      }
    });

    ws.on('close', () => {
      this.clients.delete(client);
    });

    ws.on('error', (err) => {
      console.error('[ws-bridge] Client error:', err.message);
      this.clients.delete(client);
    });

    // If no token required, send auth_ok immediately
    if (client.authenticated) {
      this.sendIdentitiesInfo(client);
    }
  }

  /**
   * Handle a message from a web client
   */
  private async handleClientMessage(client: WebClient, msg: WsClientMessage): Promise<void> {
    // Auth is always allowed
    if (msg.type === 'auth') {
      this.handleAuth(client, msg);
      return;
    }

    // Ping is always allowed
    if (msg.type === 'ping') {
      this.sendToClient(client, { type: 'pong' });
      return;
    }

    // All other messages require authentication
    if (!client.authenticated) {
      this.sendToClient(client, {
        type: 'error',
        error: 'Not authenticated. Send auth message first.',
        requestType: msg.type,
      });
      return;
    }

    switch (msg.type) {
      case 'send':
        await this.handleSend(client, msg);
        break;
      case 'inbox':
        await this.handleInbox(client, msg);
        break;
      case 'outbox':
        await this.handleOutbox(client, msg);
        break;
      case 'peers':
        await this.handlePeers(client, msg);
        break;
      case 'status':
        await this.handleStatus(client, msg);
        break;
      case 'identities':
        await this.handleIdentities(client);
        break;
      default:
        this.sendToClient(client, {
          type: 'error',
          error: `Unknown message type: ${(msg as any).type}`,
        });
    }
  }

  /**
   * Handle auth message
   */
  private handleAuth(client: WebClient, msg: { type: 'auth'; token: string; nickname?: string }): void {
    if (!this.config.token) {
      // No token configured, auto-authenticate
      client.authenticated = true;
      client.nickname = msg.nickname;
      this.sendIdentitiesInfo(client);
      return;
    }

    if (msg.token === this.config.token) {
      client.authenticated = true;
      client.nickname = msg.nickname;
      this.sendIdentitiesInfo(client);
    } else {
      this.sendToClient(client, {
        type: 'auth_fail',
        error: 'Invalid token',
      });
    }
  }

  /**
   * Send identities info as part of auth_ok
   */
  private async sendIdentitiesInfo(client: WebClient): Promise<void> {
    try {
      const result = await this.executor.executeCommand({ cmd: 'status' });
      const data = result.data as Record<string, unknown>;
      const identities = (data?.loadedIdentities || []) as Array<{ principal: string; nick?: string }>;
      this.sendToClient(client, {
        type: 'auth_ok',
        identities,
      });
    } catch {
      this.sendToClient(client, {
        type: 'auth_ok',
        identities: [],
      });
    }
  }

  /**
   * Handle send message
   */
  private async handleSend(client: WebClient, msg: { type: 'send'; to: string; content: string; as?: string }): Promise<void> {
    try {
      const result = await this.executor.executeCommand({
        cmd: 'send',
        to: msg.to,
        content: msg.content,
        as: msg.as,
      });

      if (!result.ok) {
        this.sendToClient(client, {
          type: 'error',
          error: result.error || 'Send failed',
          requestType: 'send',
        });
      }
      // Message delivery events will come through the daemon event system
    } catch (err) {
      this.sendToClient(client, {
        type: 'error',
        error: String(err),
        requestType: 'send',
      });
    }
  }

  /**
   * Handle inbox request
   */
  private async handleInbox(client: WebClient, msg: { type: 'inbox'; as?: string }): Promise<void> {
    try {
      const result = await this.executor.executeCommand({
        cmd: 'inbox',
        as: msg.as,
      });

      if (result.ok) {
        this.sendToClient(client, {
          type: 'inbox',
          messages: result.data as Message[],
        });
      } else {
        this.sendToClient(client, {
          type: 'error',
          error: result.error || 'Failed to get inbox',
          requestType: 'inbox',
        });
      }
    } catch (err) {
      this.sendToClient(client, {
        type: 'error',
        error: String(err),
        requestType: 'inbox',
      });
    }
  }

  /**
   * Handle outbox request
   */
  private async handleOutbox(client: WebClient, msg: { type: 'outbox'; as?: string }): Promise<void> {
    try {
      const result = await this.executor.executeCommand({
        cmd: 'outbox',
        as: msg.as,
      });

      if (result.ok) {
        this.sendToClient(client, {
          type: 'outbox',
          messages: result.data as Message[],
        });
      } else {
        this.sendToClient(client, {
          type: 'error',
          error: result.error || 'Failed to get outbox',
          requestType: 'outbox',
        });
      }
    } catch (err) {
      this.sendToClient(client, {
        type: 'error',
        error: String(err),
        requestType: 'outbox',
      });
    }
  }

  /**
   * Handle peers request
   */
  private async handlePeers(client: WebClient, msg: { type: 'peers'; as?: string }): Promise<void> {
    try {
      const result = await this.executor.executeCommand({
        cmd: 'peers',
        as: msg.as,
      });

      if (result.ok) {
        this.sendToClient(client, {
          type: 'peers',
          peers: result.data as Array<Peer & { connected: boolean }>,
        });
      } else {
        this.sendToClient(client, {
          type: 'error',
          error: result.error || 'Failed to get peers',
          requestType: 'peers',
        });
      }
    } catch (err) {
      this.sendToClient(client, {
        type: 'error',
        error: String(err),
        requestType: 'peers',
      });
    }
  }

  /**
   * Handle status request
   */
  private async handleStatus(client: WebClient, msg: { type: 'status'; as?: string }): Promise<void> {
    try {
      const result = await this.executor.executeCommand({
        cmd: 'status',
        as: msg.as,
      });

      if (result.ok) {
        this.sendToClient(client, {
          type: 'status',
          data: result.data as Record<string, unknown>,
        });
      } else {
        this.sendToClient(client, {
          type: 'error',
          error: result.error || 'Failed to get status',
          requestType: 'status',
        });
      }
    } catch (err) {
      this.sendToClient(client, {
        type: 'error',
        error: String(err),
        requestType: 'status',
      });
    }
  }

  /**
   * Handle identities request
   */
  private async handleIdentities(client: WebClient): Promise<void> {
    try {
      const result = await this.executor.executeCommand({ cmd: 'status' });
      const data = result.data as Record<string, unknown>;
      const identities = (data?.loadedIdentities || []) as Array<{ principal: string; nick?: string }>;
      this.sendToClient(client, {
        type: 'identities',
        identities,
      });
    } catch (err) {
      this.sendToClient(client, {
        type: 'error',
        error: String(err),
        requestType: 'identities',
      });
    }
  }

  /**
   * Send a message to a specific client
   */
  private sendToClient(client: WebClient, msg: WsServerMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Broadcast a message to all authenticated clients
   */
  private broadcast(msg: WsServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  // Arrow functions for stable `this` binding when used as event listeners
  private onDaemonMessage = (message: unknown): void => {
    this.broadcast({
      type: 'message',
      message: message as Message,
    });
  };

  private onPeerConnected = (principal: unknown): void => {
    this.broadcast({
      type: 'peer_connected',
      principal: principal as string,
    });
  };

  private onPeerDisconnected = (principal: unknown): void => {
    this.broadcast({
      type: 'peer_disconnected',
      principal: principal as string,
    });
  };

  /**
   * Handle HTTP requests for static file serving
   */
  private handleHttpRequest(req: IncomingMessage, res: import('http').ServerResponse): void {
    const staticDir = this.config.staticDir!;
    let urlPath = req.url || '/';

    // Remove query string
    urlPath = urlPath.split('?')[0];

    // Default to index.html
    if (urlPath === '/') {
      urlPath = '/index.html';
    }

    // Security: prevent directory traversal
    const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(staticDir, safePath);

    // Ensure the resolved path is within the static directory
    if (!filePath.startsWith(path.resolve(staticDir))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Check if file exists
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA fallback: serve index.html for non-file routes
      const indexPath = path.join(staticDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(indexPath).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // Determine content type
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  }

  /**
   * Get the number of connected (authenticated) web clients
   */
  get clientCount(): number {
    let count = 0;
    for (const client of this.clients) {
      if (client.authenticated) count++;
    }
    return count;
  }
}
