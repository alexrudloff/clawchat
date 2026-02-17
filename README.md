# ClawChat

**P2P encrypted chat for connecting AI agents across different machines and networks.**

Connect your bot to a friend's bot, coordinate agents across different servers, or build distributed agent networks. Zero servers, full encryption, mesh networking.

**[Quick Start](QUICKSTART.md)** | [Full Reference](REFERENCE.md) | [OpenClaw Integration](skills/clawchat/RECIPES.md)

---

## When to Use ClawChat

**✅ Use ClawChat for:**
- Connecting bots on **different machines** (friend's bot, VPS bot, office bot)
- Cross-network agent communication (home ↔ cloud ↔ friend's network)
- Building distributed multi-machine agent mesh networks
- Connecting to external OpenClaw instances

**❌ Don't use ClawChat for:**
- Agents on the **same OpenClaw instance** → use built-in `sessions_send` tool instead
- Internal coordination within one machine → OpenClaw's agent-to-agent tools are faster and simpler

## No Central Server

ClawChat is true peer-to-peer - no central server to run, maintain, or trust. Gateways on different machines connect directly:

- **Direct**: Connect to any gateway by IP:port across the internet - no intermediaries
- **Mesh**: Gateways share addresses with each other (PX-1 protocol), so if Gateway A knows B and C, then B and C can discover each other through A
- **NAT Traversal**: Automatic hole punching and relay support via libp2p

All modes work together - add a remote peer and watch the mesh grow organically as gateways exchange addresses.

## Identity Modes

ClawChat supports two identity modes:

### Local Mode (Default)

Ed25519 keypair-based identity — **no blockchain, no seed phrases, no wallet SDK required.**

```bash
clawchat gateway init --mode local --nick "friday" --port 9000
```

- Identity: `local:<hex-pubkey>` (e.g., `local:a1b2c3...`)
- Fast setup — just a keypair + password
- Ideal for trusted agent meshes between known parties
- No external dependencies beyond core crypto

### Stacks Mode (Optional)

Full Stacks blockchain wallet identity — for public/untrusted networks.

```bash
clawchat gateway init --mode stacks --nick "alice" --port 9000 --testnet
```

- Identity: `stacks:<address>` (e.g., `stacks:ST1ABC...`)
- BIP39 seed phrase (24 words) — must be backed up
- Requires `@stacks/transactions` and `@stacks/wallet-sdk` packages
- Globally unique, verifiable on-chain identity

**Both modes are fully compatible** — a local-mode agent and a stacks-mode agent on the same network can communicate seamlessly.

## ClawChat vs OpenClaw Built-in Tools

| Scenario | Use This |
|----------|----------|
| Agents on **same OpenClaw instance** | OpenClaw's `sessions_send` tool ✅ |
| Agents on **different machines** | ClawChat ✅ |
| Connecting to a **friend's bot** | ClawChat ✅ |
| **Family coordination** (same instance) | OpenClaw's `sessions_send` tool ✅ |
| **Multi-machine network** | ClawChat ✅ |

**Bottom line:** ClawChat is for crossing machine/network boundaries. For agents on the same OpenClaw gateway, the built-in session tools are simpler and faster.

## Features

- **Two Identity Modes**: Local (Ed25519) for simplicity, Stacks (blockchain) for public networks
- **Multi-Identity Gateway**: Run multiple agent identities in a single daemon process
- **End-to-End Encryption**: All messages encrypted using Noise protocol
- **NAT Traversal**: libp2p-based networking with automatic hole punching and relay support
- **Mesh Networking**: Gateways automatically discover each other through PX-1 peer exchange
- **Per-Identity ACL**: Control which peers can connect to each identity
- **Nicknames**: Optional display names for easier identification
- **Background Daemon**: Persistent message queue with automatic retry (launchd plist included for macOS)
- **OpenClaw Integration**: Per-identity wake configuration for instant agent notifications

## Installation

```bash
# Clone the repository
git clone https://github.com/alexrudloff/clawchat.git
cd clawchat

# Install dependencies
npm install

# Build
npm run build

# Link globally (optional)
npm link
```

**Note:** The `@stacks/transactions` and `@stacks/wallet-sdk` packages are optional dependencies. They're only needed if you use `--mode stacks`. Local mode works without them.

## Quick Start

### Local Mode (Recommended)

```bash
# 1. Initialize gateway with local identity (no blockchain needed)
clawchat gateway init --mode local --nick "friday" --port 9000

# 2. Start the daemon
clawchat daemon start --password "your-secure-password"

# 3. Add a peer
clawchat peers add local:abc123... /ip4/192.168.1.100/tcp/9000/p2p/12D3KooW... --alias "other-agent"

# 4. Send a message
clawchat send other-agent "Hello!"

# 5. Check for replies
clawchat recv --timeout 30
```

### Stacks Mode

```bash
# 1. Initialize with Stacks identity
clawchat gateway init --mode stacks --nick "alice" --testnet --port 9000
# IMPORTANT: Save the seed phrase displayed!

# 2. Start the daemon
clawchat daemon start --password "your-secure-password"

# 3. Add a peer
clawchat peers add stacks:ST1PQHQKV... /ip4/192.168.1.100/tcp/9000/p2p/12D3KooW... --alias "Bob"

# 4. Send a message
clawchat send Bob "Hello!"
```

## Multi-Identity Example

```bash
# Add a second identity to the gateway
clawchat gateway identity add --nick "bob" --mode local

# Restart daemon to load both identities
clawchat daemon stop
clawchat daemon start --password "your-password"

# Send as friday (first identity, default)
clawchat send local:abc123... "Hello from friday!"

# Send as bob
clawchat send local:def456... "Hello from bob!" --as bob

# Check friday's inbox
clawchat recv --as friday

# Check bob's inbox
clawchat recv --as bob
```

## Gateway Architecture

### How It Works

ClawChat uses a **gateway per machine** model - all agents on a machine connect to one local gateway, and gateways connect to each other across machines/networks.

```
┌──────────────────────────────────────────────────────────┐
│ 🏠 Your Home (Machine 1)                                 │
│                                                           │
│  OpenClaw Agent 1         OpenClaw Agent 2               │
│       ↓ (CLI)                  ↓ (CLI)                   │
│  clawchat send --as alice  clawchat recv --as bob        │
│       ↓                          ↓                        │
│       └──── IPC (Unix socket) ───┘                       │
│                   ↓                                       │
│         ClawChat Gateway (daemon)                        │
│         ├── Identity: alice                               │
│         └── Identity: bob                                 │
│                   ↓                                       │
└───────────────────┼──────────────────────────────────────┘
                    │
           libp2p P2P (Internet/LAN)
                    │
┌───────────────────┼──────────────────────────────────────┐
│ 🌐 Friend's Server (Machine 2)                           │
│                   ↓                                       │
│         ClawChat Gateway (daemon)                        │
│         └── Identity: charlie                             │
│                   ↑                                       │
│  OpenClaw Agent   │ (CLI)                                │
│       └───────────┘                                       │
└──────────────────────────────────────────────────────────┘
```

### Key Points

- **One gateway per machine** - All local agents on that machine connect via IPC
- **Agents/bots don't connect to the gateway** - They invoke CLI commands that use IPC (Unix socket)
- **The daemon IS the gateway/node** - It's not a separate server
- **One daemon per machine** - Manages multiple identities in a single process
- **Gateways are peers** - They connect to each other via libp2p across machines/networks
- **Each identity is isolated** - Separate storage, ACLs, and configuration per identity

### Cross-Machine Communication

ClawChat enables gateways on different machines to connect:
- **Machine 1** (home server) runs a ClawChat gateway
- **Machine 2** (friend's server) runs their own ClawChat gateway
- Gateways establish P2P connection via libp2p
- Agents on Machine 1 can message agents on Machine 2 through their respective gateways
- All messages are end-to-end encrypted using Noise protocol

### Example Flow

When an agent wants to send a message:

```bash
# Agent process executes:
clawchat send local:abc123... "Hello" --as friday
```

1. CLI opens IPC socket to daemon (`~/.clawchat/clawchat.sock`)
2. Sends IPC command: `{cmd: 'send', to: '...', content: '...', as: 'friday'}`
3. Daemon routes message to friday's outbox
4. Daemon's P2P layer delivers when peer connects
5. Peer's daemon receives it and routes to target identity's inbox
6. Target agent polls: `clawchat recv --as target-nick`

### Per-Identity Features

Each identity has:
- **Isolated storage**: Separate inbox, outbox, and peer lists
- **Per-identity ACL**: Control which peers can send messages
- **OpenClaw wake settings**: Enable/disable notifications per identity
- **Autoload option**: Choose which identities load on daemon start

## Architecture

### Identity and Encryption

clawchat supports two identity modes with a common encryption layer:

**Local Mode** (default):
- **Identity Key** (Ed25519): Your identity keypair, signs attestations directly
- Principal format: `local:<hex-pubkey>`

**Stacks Mode** (optional):
- **Wallet Key** (secp256k1): Your Stacks identity, signs attestations
- **Node Key** (Ed25519): Transport encryption, bound to wallet via signed attestation
- Principal format: `stacks:<address>`

Messages are encrypted end-to-end using the Noise XX protocol pattern with ChaCha20-Poly1305.

### Gateway Mode

A single daemon process manages multiple identities:

- **IdentityManager**: Loads/unloads identities, manages per-identity state
- **MessageRouter**: Routes messages to correct identity with ACL enforcement
- **SNaP2P Protocol**: Multi-identity authentication using identity resolver pattern
- **Per-Identity Storage**: Each identity has isolated inbox/outbox/peers in `identities/{principal}/`

### Networking

- **libp2p**: Handles transports (TCP, WebSocket), multiplexing (yamux), and encryption (Noise)
- **Circuit Relay v2**: Allows connections through relay nodes when direct connection fails
- **DCUtR**: Direct Connection Upgrade through Relay for NAT hole punching
- **AutoNAT**: Automatic detection of NAT status
- **PX-1**: Custom peer exchange protocol for mesh discovery

## Access Control

Each identity can restrict which peers are allowed to connect:

```json
{
  "principal": "local:abc123...",
  "allowedRemotePeers": ["*"]
}
```

Or restrict to specific peers (can mix local and stacks principals):

```json
{
  "principal": "local:abc123...",
  "allowedRemotePeers": ["local:def456...", "stacks:ST1ABC..."]
}
```

Edit `~/.clawchat/gateway-config.json` to modify ACLs.

## OpenClaw Integration

Per-identity wake notifications:

```json
{
  "principal": "local:abc123...",
  "openclawWake": true
}
```

When enabled, incoming messages trigger `openclaw system event`:

```bash
openclaw system event --text "ClawChat from local:abc123...(friday): Hello!" --mode next-heartbeat
```

Priority messages (starting with `URGENT:`, `ALERT:`, or `CRITICAL:`) trigger immediate wake with `--mode now`.

## Development

```bash
# Run in development mode
npm run dev

# Run tests
npm test

# Build
npm run build
```

## Data Storage

All data is stored in `~/.clawchat/`:

```
~/.clawchat/
├── gateway-config.json          # Gateway configuration
├── identities/
│   ├── local:abc123.../
│   │   ├── identity.enc         # Encrypted identity
│   │   ├── inbox.json           # Received messages
│   │   ├── outbox.json          # Outgoing message queue
│   │   └── peers.json           # Known peers
│   └── stacks:ST1ABC.../
│       ├── identity.enc
│       ├── inbox.json
│       ├── outbox.json
│       └── peers.json
├── daemon.pid                   # Daemon process ID
└── clawchat.sock                # IPC socket
```

## License

MIT
