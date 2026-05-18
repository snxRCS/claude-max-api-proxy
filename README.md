# Claude Code CLI Provider

**Use your Claude Max subscription ($200/month) with any OpenAI-compatible client — no separate API costs!**

This provider wraps the Claude Code CLI as a subprocess and exposes an OpenAI-compatible HTTP API, allowing tools like Clawdbot, Continue.dev, or any OpenAI-compatible client to use your Claude Max subscription instead of paying per-API-call.

## Why This Exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Claude API | ~$15/M input, ~$75/M output tokens | Pay per use |
| Claude Max | $200/month flat | OAuth blocked for third-party API use |
| **This Provider** | $0 extra (uses Max subscription) | Routes through CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. However, the Claude Code CLI *can* use OAuth tokens. This provider bridges that gap by wrapping the CLI and exposing a standard API.

## How It Works

```
Your App (Clawdbot, etc.)
         ↓
    HTTP Request (OpenAI format)
         ↓
   Claude Code CLI Provider (this project)
         ↓
   Claude Code CLI (subprocess)
         ↓
   OAuth Token (from Max subscription)
         ↓
   Anthropic API
         ↓
   Response → OpenAI format → Your App
```

## Features

- **OpenAI-compatible API** — Works with any client that supports OpenAI's API format
- **Streaming support** — Real-time token streaming via Server-Sent Events
- **Multiple models** — Claude Opus, Sonnet, and Haiku
- **Session management** — Maintains conversation context
- **Auto-start service** — Optional LaunchAgent (macOS) or systemd unit (Linux)
- **Zero configuration** — Uses existing Claude CLI authentication
- **Secure by design** — Uses spawn() to prevent shell injection

## Prerequisites

1. **Claude Max subscription** ($200/month) — [Subscribe here](https://claude.ai)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

## Installation

```bash
# Clone the repository
git clone https://github.com/anthropics/claude-code-cli-provider.git
cd claude-code-cli-provider

# Install dependencies
npm install

# Build
npm run build
```

## Usage

### Start the server

```bash
node dist/server/standalone.js
```

The server runs at `http://localhost:3456` by default.

### Test it

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Chat completion (streaming)
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |

## Available Models

| Model ID | Maps To |
|----------|---------|
| `claude-opus-4` | Claude Opus 4.5 |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4` | Claude Haiku 4 |

## Configuration with Popular Tools

### Clawdbot

Clawdbot has **built-in support** for Claude CLI OAuth! Check your config:

```bash
clawdbot models status
```

If you see `anthropic:claude-cli=OAuth`, you're already using your Max subscription.

### Continue.dev

Add to your Continue config:

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "claude-opus-4",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### OpenClaw

[OpenClaw](https://openclaw.ai) is an autonomous AI agent platform. To use this provider as a model inside OpenClaw, add the following to your `~/.openclaw/openclaw.json`:

```json
{
  "env": {
    "OPENAI_API_KEY": "not-needed",
    "OPENAI_BASE_URL": "http://localhost:3456/v1"
  },
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "http://localhost:3456/v1",
        "api": "openai-completions",
        "apiKey": "OPENAI_API_KEY",
        "models": [
          {
            "id": "claude-opus-4",
            "name": "Claude Opus 4",
            "contextWindow": 200000,
            "maxTokens": 16384
          },
          {
            "id": "claude-sonnet-4",
            "name": "Claude Sonnet 4",
            "contextWindow": 200000,
            "maxTokens": 16384
          },
          {
            "id": "claude-haiku-4",
            "name": "Claude Haiku 4",
            "contextWindow": 200000,
            "maxTokens": 16384
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/claude-sonnet-4"
      }
    }
  }
}
```

Then restart OpenClaw. The proxy models will appear as `openai/claude-sonnet-4`, `openai/claude-opus-4`, etc. To select a model for the current session, use `/model openai/claude-sonnet-4`.

> **Note:** `OPENAI_API_KEY` can be any non-empty string — the proxy ignores it. `OPENAI_BASE_URL` must point to the running proxy.

### Generic OpenAI Client (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed"  # Any value works
)

response = client.chat.completions.create(
    model="claude-opus-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Auto-Start

### macOS

Create a LaunchAgent to start the provider automatically on login. See `docs/macos-setup.md` for detailed instructions.

### Linux (systemd)

Create a user-level systemd service so the proxy starts automatically on login/boot:

1. Create the service file:

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/claude-max-proxy.service << 'EOF'
[Unit]
Description=Claude Max API Proxy (OpenAI-compatible)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/claude-max-api-proxy/dist/server/standalone.js
Restart=on-failure
RestartSec=5
Environment=HOME=%h
Environment=PATH=%h/.nvm/versions/node/v25.8.1/bin:/usr/local/bin:/usr/bin:/bin
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
```

2. **Edit the file** and replace `/path/to/claude-max-api-proxy` with the actual path (e.g. `/home/mark/hireloom-workspace/claude-max-api-proxy`). Also update the `node` path and the `PATH` to match your system (check with `which node` and `which claude`).

3. Enable and start the service:

```bash
# Reload systemd, enable, and start
systemctl --user daemon-reload
systemctl --user enable claude-max-proxy
systemctl --user start claude-max-proxy

# Verify it's running
systemctl --user status claude-max-proxy
curl http://localhost:3456/health
```

4. To ensure the service keeps running after logout (e.g. on a server/Pi), enable lingering:

```bash
sudo loginctl enable-linger $USER
```

#### Management Commands

```bash
# Check status
systemctl --user status claude-max-proxy

# View live logs
journalctl --user -u claude-max-proxy -f

# Restart
systemctl --user restart claude-max-proxy

# Stop
systemctl --user stop claude-max-proxy

# Disable autostart
systemctl --user disable claude-max-proxy
```

#### Uninstall

```bash
systemctl --user stop claude-max-proxy
systemctl --user disable claude-max-proxy
rm ~/.config/systemd/user/claude-max-proxy.service
systemctl --user daemon-reload
```

## Architecture

```
src/
├── types/
│   ├── claude-cli.ts      # Claude CLI JSON output types
│   └── openai.ts          # OpenAI API types
├── adapter/
│   ├── openai-to-cli.ts   # Convert OpenAI requests → CLI format
│   └── cli-to-openai.ts   # Convert CLI responses → OpenAI format
├── subprocess/
│   └── manager.ts         # Claude CLI subprocess management
├── session/
│   └── manager.ts         # Session ID mapping
├── server/
│   ├── index.ts           # Express server setup
│   ├── routes.ts          # API route handlers
│   └── standalone.ts      # Entry point
└── index.ts               # Package exports
```

## Security

- Uses Node.js `spawn()` instead of shell execution to prevent injection attacks
- No API keys stored or transmitted by this provider
- All authentication handled by Claude CLI's secure keychain storage
- Prompts passed as CLI arguments, not through shell interpretation

## Cost Savings Example

| Usage | API Cost | With This Provider |
|-------|----------|-------------------|
| 1M input tokens/month | ~$15 | $0 (included in Max) |
| 500K output tokens/month | ~$37.50 | $0 (included in Max) |
| **Monthly Total** | **~$52.50** | **$0 extra** |

If you're already paying for Claude Max, this provider lets you use that subscription for API-style access at no additional cost.

## Troubleshooting

### "Claude CLI not found"

Install and authenticate the CLI:
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### Streaming returns immediately with no content

Ensure you're using `-N` flag with curl (disables buffering):
```bash
curl -N -X POST http://localhost:3456/v1/chat/completions ...
```

### Server won't start

Check that the Claude CLI is in your PATH:
```bash
which claude
```

## Contributing

Contributions welcome! Please submit PRs with tests.

## License

MIT

## Acknowledgments

- Built for use with [Clawdbot](https://clawd.bot)
- Powered by [Claude Code CLI](https://github.com/anthropics/claude-code)
# yolo2
# YOLO
# YOLO attempt 4 - proper admin bypass
