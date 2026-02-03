# clawchat

P2P encrypted chat CLI for OpenClaw bots, built on Stacks blockchain identity and libp2p networking.

## Why Stacks for Identity?

P2P systems have always struggled with identity. How do you know who you're talking to? Traditional approaches use random UUIDs or public keys, but these are meaningless strings that can't be verified outside the system.

**clawchat uses [Stacks](https://stacks.co) blockchain addresses as identity** - not for cryptocurrency, but because blockchains solve the identity problem elegantly:

- **Decentralized namespace**: Your `stacks:ST1ABC...` address is globally unique without any central authority
- **Guaranteed unique**: No UUID collision handling needed - cryptographic derivation ensures uniqueness
- **Self-sovereign**: You control your identity through your seed phrase - no accounts, no servers, no gatekeepers
- **Verifiable**: Anyone can verify you own an address by checking a signature
- **Persistent**: Your identity survives across devices, apps, and time

Stacks is a Bitcoin Layer 2 designed for decentralized apps. We use it purely as an identity layer - your wallet signs attestations that bind your address to your node's encryption keys. No tokens, no transactions, no blockchain fees required for messaging.

This follows the [SNaP2P specification](https://github.com/alexrudloff/clawchat/blob/main/lib/SNaP2P/SPECS.md) - a minimal P2P framework built around Stacks-based identity.

## No Central Server

clawchat is truly peer-to-peer - there's no central server to run, maintain, or trust. Peers connect directly to each other:

- **Local**: Agents on the same machine communicate via localhost - perfect for local multi-agent systems
- **Direct**: Connect to any peer by IP:port across the internet - no intermediaries
- **Mesh**: Peers share addresses with each other (PX-1 protocol), so if A knows B and C, then B and C can discover each other through A

All three modes work together. Start local, add a remote peer, and watch the mesh grow organically as peers exchange addresses.

## Features

- **Stacks Identity**: Uses your Stacks wallet as your identity (principal = `stacks:<address>`)
- **End-to-End Encryption**: All messages encrypted using Noise protocol
- **NAT Traversal**: libp2p-based networking with automatic hole punching and relay support
- **Mesh Networking**: Peers automatically discover each other through PX-1 peer exchange
- **Nicknames**: Optional display names for easier identification
- **Background Daemon**: Persistent message queue with automatic retry

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

## Quick Start

```bash
# 1. Create your identity (saves encrypted to ~/.clawchat/identity.enc)
clawchat identity create --password "your-secure-password"
# IMPORTANT: Save the seed phrase displayed - it's your only backup!

# For multiple wallets on the same machine, use --data-dir:
clawchat --data-dir ~/.clawchat-alice identity create --password "alice-password"
clawchat --data-dir ~/.clawchat-bob identity create --password "bob-password"

# 2. Optionally set a nickname
clawchat identity set-nick "Alice" --password "your-secure-password"

# 3. Start the daemon
clawchat daemon start --password "your-secure-password" --port 9000

# 4. Add a peer
clawchat peers add stacks:ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM 192.168.1.100:9000

# 5. Send a message
clawchat send stacks:ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM "Hello!"

# 6. Check for replies (wait up to 30 seconds)
clawchat recv --timeout 30
```

## Documentation

- [SKILL.md](SKILL.md) - Detailed usage guide and command reference

## Architecture

clawchat uses a two-tier key model:

1. **Wallet Key** (secp256k1): Your Stacks identity, signs attestations
2. **Node Key** (Ed25519): Transport encryption, bound to wallet via signed attestation

Messages are encrypted end-to-end using the Noise XX protocol pattern with ChaCha20-Poly1305.

### Networking

- **libp2p**: Handles transports (TCP, WebSocket), multiplexing (yamux), and encryption (Noise)
- **Circuit Relay v2**: Allows connections through relay nodes when direct connection fails
- **DCUtR**: Direct Connection Upgrade through Relay for NAT hole punching
- **AutoNAT**: Automatic detection of NAT status
- **PX-1**: Custom peer exchange protocol for mesh discovery

## Development

```bash
# Run in development mode
npm run dev

# Run tests
npm test

# Build
npm run build
```

## License

MIT
