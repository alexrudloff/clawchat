# ClawChat OpenClaw Channel Plugin

This extension makes ClawChat available as a native OpenClaw messaging channel,
alongside Telegram, Discord, BlueBubbles, etc. Messages route through OpenClaw's
binding system instead of the shell-out (`openclaw system event`) approach.

## Prerequisites

- [OpenClaw](https://github.com/alexrudloff/openclaw) installed and configured
- [ClawChat](https://github.com/alexrudloff/clawchat) daemon running with at least one identity

## Installation

### Option A: Symlink (development)

```bash
openclaw plugins install -l ./extensions/openclaw-plugin
```

### Option B: Copy install

```bash
openclaw plugins install ./extensions/openclaw-plugin
```

### Option C: npm (when published)

```bash
openclaw plugins install @openclaw/clawchat
```

After installing, restart the OpenClaw gateway:

```bash
openclaw gateway restart
```

## Configuration

Add ClawChat configuration under `channels.clawchat` in your OpenClaw config:

### Minimal (single identity)

```json5
{
  channels: {
    clawchat: {
      enabled: true,
      principal: "stacks:ST1ABC...",  // Your ClawChat identity principal
      dmPolicy: "allowlist",
      allowFrom: [
        "stacks:ST2XYZ...",          // Allowed sender principals
      ],
    },
  },
}
```

### Multi-account

```json5
{
  channels: {
    clawchat: {
      enabled: true,
      accounts: {
        alice: {
          principal: "stacks:ST1ALICE...",
          dmPolicy: "allowlist",
          allowFrom: ["stacks:ST1BOB..."],
        },
        bob: {
          principal: "stacks:ST1BOB...",
          dmPolicy: "open",
        },
      },
    },
  },
}
```

### Configuration options

| Key              | Type       | Default        | Description                                         |
|------------------|------------|----------------|-----------------------------------------------------|
| `enabled`        | boolean    | `true`         | Enable/disable the ClawChat channel                 |
| `principal`      | string     | —              | ClawChat identity principal to use                  |
| `dataDir`        | string     | `~/.clawchat`  | Path to ClawChat data directory                     |
| `password`       | string     | —              | Password for identity (prefer `passwordFile`)       |
| `passwordFile`   | string     | —              | Path to file containing the password                |
| `dmPolicy`       | string     | `"allowlist"`  | DM policy: `pairing`, `allowlist`, `open`, `disabled` |
| `allowFrom`      | string[]   | `[]`           | Allowed sender principals                           |
| `textChunkLimit` | number     | `4000`         | Max characters per outbound message chunk           |
| `pollIntervalMs` | number     | `3000`         | Poll interval for inbound messages (ms)             |

## How it works

### Outbound messages

When OpenClaw sends a message via ClawChat, the plugin communicates with the
ClawChat daemon through its Unix socket IPC (`~/.clawchat/clawchat.sock`).
It sends a `send` command with the recipient principal and message text.

### Inbound messages

The plugin polls the ClawChat daemon IPC using the `recv` command with a
`--since` timestamp and `--timeout` for efficient long-polling. New messages
are normalized into OpenClaw's inbound message format and dispatched through
the standard reply pipeline.

### DM Policy & Pairing

ClawChat follows the same DM policy model as other OpenClaw channels:

- **`pairing`** — Unknown senders get a pairing code; approve via `openclaw channels approve`
- **`allowlist`** — Only principals in `allowFrom` can send messages
- **`open`** — Anyone can send messages
- **`disabled`** — No inbound messages accepted

### Identity mapping

ClawChat principals (`stacks:ST1ABC...` or `local:abc123...`) map directly to
peer IDs in OpenClaw bindings. The `allowFrom` config uses these principals.

## Architecture

```
OpenClaw Gateway
  └── ClawChat Channel Plugin
        ├── monitor.ts    ← polls daemon IPC for inbound messages
        ├── send.ts       ← sends outbound via daemon IPC
        ├── ipc.ts        ← Unix socket client for clawchat.sock
        └── channel.ts    ← ChannelPlugin wiring

ClawChat Daemon (separate process)
  ├── libp2p P2P networking
  ├── SNaP2P authentication
  ├── Unix socket IPC (clawchat.sock)
  └── Message routing & delivery
```

## Backward Compatibility

This plugin is optional. ClawChat works perfectly fine without OpenClaw installed.
The existing `openclaw system event` shell-out integration in the daemon's
`openclawWake` feature continues to work independently.

## Sending messages via CLI

Once configured, you can send messages through OpenClaw:

```bash
openclaw send --channel clawchat --to "stacks:ST1ABC..." "Hello from OpenClaw!"
```

Or create a binding so messages route automatically:

```bash
openclaw bind --channel clawchat --to "stacks:ST1ABC..."
```
