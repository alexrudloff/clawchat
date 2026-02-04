# Plan: Gateway/Relay Architecture for Multi-Identity ClawChat

## Goal
Refactor clawchat to use ONE daemon process that handles MULTIPLE local agent identities, providing:
- Memory efficiency (one libp2p node instead of N daemons)
- Centralized security (ACL/whitelist per identity)
- Per-identity message routing
- Identity-specific OpenClaw wake support

## Current vs Proposed Architecture

### Current (One Daemon Per Identity)
```
Cora Daemon (port 9100) ←→ P2P Network
Test Daemon (port 9200) ←→ P2P Network
```
**Problem:** N agents = N daemons = N × memory overhead

### Proposed (Gateway with Virtual Identities)
```
Gateway Daemon (port 9000)
    ↕ (P2P Network)
    ↕ (IPC with --as selector)
Cora (virtual identity)
Test (virtual identity)
AliceBot (virtual identity)
```
**Benefits:** One daemon, multiple virtual identities, centralized routing

## Core Components

### 1. IdentityManager Class
**Location:** New file `src/daemon/identity-manager.ts`

Manages multiple virtual identities within gateway:
- Load/unload identities from encrypted storage
- Route messages to correct identity by principal
- Maintain per-identity sessions, inbox, outbox, peers
- Enforce ACLs (whitelist) per identity

```typescript
class IdentityManager {
  private identities: Map<string, FullIdentity>;
  private identityConfigs: Map<string, IdentityConfig>;

  async loadIdentity(principal: string, password: string): Promise<void>
  unloadIdentity(principal: string): void
  getIdentity(principalOrNick: string): FullIdentity | null
  routeMessage(toPrincipal: string, message: Message): boolean
  isAuthorized(localIdentity: string, remotePrincipal: string): boolean
}
```

### 2. Per-Identity Storage Structure

```
~/.clawchat/
├── gateway-config.json           # Gateway configuration
├── daemon.pid                    # Gateway daemon PID
├── clawchat.sock                 # IPC socket
└── identities/                   # Per-identity isolation
    ├── stacks:ST1ABC.../         # Identity 1 (Cora)
    │   ├── identity.enc
    │   ├── inbox.json
    │   ├── outbox.json
    │   └── peers.json
    ├── stacks:ST2DEF.../         # Identity 2 (Test)
    │   ├── identity.enc
    │   ├── inbox.json
    │   ├── outbox.json
    │   └── peers.json
    └── ...
```

### 3. Gateway Configuration Format

**File:** `~/.clawchat/gateway-config.json`

```json
{
  "version": 1,
  "p2pPort": 9000,
  "identities": [
    {
      "principal": "stacks:ST1ABC...",
      "nick": "cora",
      "openclawWake": true,
      "allowLocal": true,
      "allowedRemotePeers": ["*"],
      "autoload": true
    },
    {
      "principal": "stacks:ST2DEF...",
      "nick": "test",
      "openclawWake": false,
      "allowLocal": true,
      "allowedRemotePeers": ["stacks:ST999..."],
      "autoload": true
    }
  ]
}
```

**Configuration Options:**
- `openclawWake` - Enable automatic wake for this identity
- `allowLocal` - Allow IPC access (CLI commands)
- `allowedRemotePeers` - Whitelist of principals (or "*" for all)
- `autoload` - Load on daemon start

## Implementation Changes

### 1. Daemon Refactoring
**File:** `src/daemon/server.ts`

**Current:**
```typescript
class Daemon {
  private identity: FullIdentity;  // Single identity
  private inbox: Message[];        // Shared inbox
  private outbox: Message[];       // Shared outbox
  private peers: Peer[];           // Shared peers
}
```

**New:**
```typescript
class GatewayDaemon {
  private identityManager: IdentityManager;  // Multiple identities
  private messageRouter: MessageRouter;       // Routes by principal
  private aclManager: AccessControlManager;   // Per-identity ACLs

  // Inboxes/outboxes/peers now stored per-identity
  // via IdentityManager
}
```

### 2. IPC Protocol Extension
**File:** `src/daemon/server.ts`

Add identity selector to all commands:

```typescript
export type IpcCommand =
  | { cmd: 'send'; as?: string; to: string; content: string }
  | { cmd: 'recv'; as?: string; since?: number; timeout?: number }
  | { cmd: 'inbox'; as?: string }
  | { cmd: 'identities:list' }
  | { cmd: 'identities:load'; principal: string; password: string }
  | { cmd: 'identities:unload'; principal: string }
  | ...
```

- `as` parameter specifies which identity to use
- If omitted, use "primary" identity (first in config)
- Backward compatible with single-identity mode

### 3. CLI Changes
**File:** `src/cli.ts`

Add global `--as` option:

```bash
clawchat --as cora send stacks:ST999... "Hello"
clawchat --as test inbox
clawchat identities list
clawchat identities load stacks:ST3GHI... --password-file ~/.alice-password
```

### 4. Message Routing Logic
**New file:** `src/daemon/message-router.ts`

```typescript
class MessageRouter {
  // Inbound: P2P → Identity Inbox
  handleIncomingMessage(msg: Message, session: Snap2pSession): void {
    const identity = this.identityManager.getIdentity(msg.to);
    if (!identity) return;

    // Check ACL
    if (!this.aclManager.canSendTo(msg.from, msg.to)) {
      console.error(`Unauthorized: ${msg.from} → ${msg.to}`);
      return;
    }

    // Route to identity's inbox
    this.saveToInbox(identity.principal, msg);

    // Trigger openclaw wake if enabled
    if (identity.config.openclawWake) {
      this.triggerOpenclawWake(identity, msg);
    }
  }

  // Outbound: Identity → P2P
  async sendMessage(fromPrincipal: string, to: string, content: string): Promise<void> {
    const identity = this.identityManager.getIdentity(fromPrincipal);
    if (!identity) throw new Error(`Identity not loaded: ${fromPrincipal}`);

    const message = { from: identity.principal, to, content, ... };
    this.saveToOutbox(identity.principal, message);
    await this.tryDeliver(identity, message);
  }
}
```

### 5. Multi-Identity SNaP2P Authentication
**File:** `src/net/snap2p-protocol.ts`

Extend to support multiple identities authenticating through same P2P node:
- Gateway node has transport identity (Ed25519 node key)
- Each virtual identity presents its own Stacks attestation
- Session includes identity context for message routing

### 6. OpenClaw Wake Per Identity
**File:** `src/daemon/server.ts` (openclaw wake logic)

```typescript
private triggerOpenclawWake(identity: FullIdentity, message: Message): void {
  const config = this.identityManager.getConfig(identity.principal);
  if (!config.openclawWake) return;

  // Determine priority
  const isUrgent = ['URGENT:', 'ALERT:', 'CRITICAL:'].some(
    prefix => message.content.startsWith(prefix)
  );
  const mode = isUrgent ? 'now' : 'next-heartbeat';

  // Format: "ClawChat from {sender}: {content}"
  const wakeMessage = `ClawChat from ${message.from}: ${message.content}`;

  spawnSync('openclaw', ['wake', wakeMessage, '--mode', mode], {
    timeout: 5000,
    stdio: 'ignore'
  });
}
```

### 7. Security & ACL
**New file:** `src/daemon/acl-manager.ts`

```typescript
class AccessControlManager {
  // Check if remote principal can send to local identity
  canSendTo(remotePrincipal: string, localIdentity: string): boolean {
    const config = this.identityManager.getConfig(localIdentity);
    if (config.allowedRemotePeers.includes('*')) return true;
    return config.allowedRemotePeers.includes(remotePrincipal);
  }

  // Check if IPC client can access identity
  canAccessViaIpc(localIdentity: string): boolean {
    const config = this.identityManager.getConfig(localIdentity);
    return config.allowLocal;
  }
}
```

## Migration Path

### Phase 1: Single Identity Mode (Backward Compatible)
- Existing users continue unchanged
- No gateway-config.json = single identity mode (current behavior)

### Phase 2: Gateway Mode Conversion
```bash
# Convert existing identity to gateway mode
clawchat gateway init

# Creates gateway-config.json with existing identity as primary
# Moves identity.enc to identities/<principal>/identity.enc
```

### Phase 3: Multi-Identity Setup
```bash
# Add additional identities
clawchat identity create --gateway --nick test --password-file ~/.test-password
clawchat identity create --gateway --nick alicebot --password-file ~/.alice-password

# Start gateway daemon
clawchat daemon start --gateway-config ~/.clawchat/gateway-config.json
```

## Implementation Sequence

1. **Core Infrastructure** (Phase 1)
   - Create IdentityManager class
   - Per-identity storage structure
   - Gateway config loading

2. **Message Routing** (Phase 2)
   - MessageRouter implementation
   - Inbound/outbound routing
   - ACL enforcement

3. **Multi-Identity SNaP2P** (Phase 3)
   - Extend authentication for identity context
   - Update session management

4. **CLI Extensions** (Phase 4)
   - Add `--as` global option
   - Identity management commands
   - Backward compatibility

5. **OpenClaw Integration** (Phase 5)
   - Per-identity wake configuration
   - Priority routing

6. **Testing & Migration** (Phase 6)
   - Migration script
   - E2E tests with multiple identities
   - Performance testing

## Critical Files

- **src/daemon/server.ts** - Refactor to GatewayDaemon
- **src/daemon/identity-manager.ts** - NEW: Identity registry
- **src/daemon/message-router.ts** - NEW: Message routing
- **src/daemon/acl-manager.ts** - NEW: Access control
- **src/identity/keys.ts** - Extend for multi-identity
- **src/cli.ts** - Add --as option and identity commands
- **src/net/snap2p-protocol.ts** - Multi-identity auth
- **src/types.ts** - Add gateway types

## Verification

1. **Single identity mode still works** (backward compatibility)
2. **Three identities in gateway mode:**
   - Each has separate inbox/outbox
   - ACL blocks unauthorized senders
   - OpenClaw wake per identity works
3. **Memory usage:** Gateway < 3 × single daemon
4. **CLI commands work with --as selector**
5. **Migration from single to gateway mode succeeds**

## Trade-offs

### Advantages
- **Memory efficient:** One libp2p node
- **Centralized security:** ACL/whitelist per identity
- **Simpler network:** One P2P endpoint
- **Unified management:** Single daemon to monitor

### Risks & Mitigations
- **Single point of failure:** Daemon crash affects all → Robust error handling, launchd auto-restart
- **Identity isolation:** Cross-identity leakage → Strict data separation, per-identity storage
- **Authentication complexity:** SNaP2P extension → Careful protocol design, maintain backward compatibility

**Note:** Routing logic is NOT more complex - just a simple map lookup by principal. Actually simpler than managing multiple P2P nodes.
