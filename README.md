# Beesy

Agent orchestration platform that turns Slack slash commands into automated AI workflows.

## How It Works

```
Slack slash command
  -> Gate Router (matches command to YAML workflow)
  -> BullMQ Queue (priority-ordered, one task at a time)
  -> Task Executor (deterministic for-loop through steps)
  -> Subtask Dispatcher (routes to agent/script/tool runner)
  -> CLI Backend (spawns claude/codex/gemini subprocess)
  -> Response sent back to Slack
```

Workflows are defined in YAML files (gates). Each gate declares a sequence of steps. Steps can be:

- **agent** -- AI model session via CLI backend (claude, codex, gemini)
- **script** -- external process (Python/shell) with JSON stdin/stdout contract
- **tool** -- in-process TypeScript function call

## Quick Start

```bash
# Prerequisites: Node.js 22+, Redis, Docker

# Install
npm install

# Start Redis
docker compose up -d

# Configure
cp .env.example .env
# Fill in: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, ANTHROPIC_API_KEY

# Run
npm run dev
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Slack bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | Slack app-level token for Socket Mode (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | Yes | Slack request verification |
| `REDIS_URL` | Yes | Redis connection URL (default: `redis://localhost:6379`) |
| `GITHUB_TOKEN` | No | GitHub PAT for workspace operations |
| `ANTHROPIC_API_KEY` | Yes* | For cli-claude backend |
| `CODEX_API_KEY` | No | For cli-codex backend |
| `GEMINI_API_KEY` | No | For cli-gemini backend |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default: `info`) |

*Required if using gates with `anthropic/*` models.

## Gates

Gates live in `gates/` as YAML files. The router auto-discovers them at startup.

```yaml
# gates/my-gate.yaml
gate:
  id: my-gate
  name: "My Gate"
  command: /my-gate
  description: "Does something useful"

input:
  required:
    - description: "What to do"

workflow:
  steps:
    - step_one

steps:
  step_one:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        tools: [read, write, bash]
        timeoutMs: 300000
    behavior: "Describe what the step does"
```

### Built-in Gates

| Command | Description |
|---------|-------------|
| `/new-implementation` | Full implementation workflow (stub -- Phase 2) |
| `/test-trivial` | Single-step echo gate for pipeline testing |

## Agent Backends

The agent runner uses a pluggable backend adapter pattern. Each backend spawns a CLI subprocess:

| Backend | CLI | Auto-resolved from | Key env var |
|---------|-----|-------------------|-------------|
| `cli-claude` | `claude` | `anthropic/*` models | `ANTHROPIC_API_KEY` |
| `cli-codex` | `codex` | `openai/*` models | `CODEX_API_KEY` |
| `cli-gemini` | `gemini` | `google/*` models | `GEMINI_API_KEY` |

Mix models within a single workflow by setting different models per step in the gate YAML.

## Project Structure

```
bees/
├── src/
│   ├── index.ts              # Entry point, composition root
│   ├── adapters/             # Slack adapter (Socket Mode)
│   ├── gates/                # YAML loader, router, validation
│   ├── queue/                # BullMQ wrapper, priority queue
│   ├── executor/             # Task executor, dispatcher, script/tool runners
│   ├── runners/              # Agent backend system
│   │   ├── registry.ts       # Backend registry + resolution
│   │   ├── cli-backend.ts    # Shared CLI subprocess lifecycle
│   │   ├── cli-claude.ts     # Claude flag mapping
│   │   ├── cli-codex.ts      # Codex flag mapping
│   │   ├── cli-gemini.ts     # Gemini flag mapping
│   │   └── prompt-builder.ts # Prompt assembly (system + skills + context)
│   └── utils/                # Config, logger
├── gates/                    # Gate YAML definitions
├── skills/                   # Skill files (injected into agent prompts)
├── tests/                    # Vitest test suite
└── docker-compose.yml        # Redis
```

## Production Deployment

```bash
# Build
npx tsc

# Run with PM2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Bees uses Slack Socket Mode -- no public URL, TLS, or ingress configuration needed. The service connects outbound to Slack over WebSocket.

## Development

```bash
npm run dev          # Run with tsx (auto-reload)
npm test             # Run tests
npm run type-check   # TypeScript validation
npm run build        # Compile to dist/
```

## Architecture

- **Sequential queue** -- one task at a time, priority-ordered (critical > high > normal > low)
- **Deterministic executor** -- no LLM decisions in the orchestration loop
- **Agent-agnostic** -- no vendor SDK dependency; CLI backends are swappable per step
- **Gate-driven** -- all work enters through YAML-defined gates
- **Workspace isolation** -- each task gets its own git worktree

## Status

**Phase 1 (Skeleton) -- Complete.** The end-to-end pipeline works: Slack command to AI response.

Remaining phases:
- Phase 2: `/new-implementation` 10-step workflow, human interaction, context passing
- Phase 3: Cron jobs, cost tracking, queue management commands
- Phase 4: Team rollout, VPS deployment, documentation
