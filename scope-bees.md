# Project Bees — Agent Orchestration Platform

## Planning Document v3.4

**Codename:** Bees
**Date:** 2026-04-05
**Status:** Planning
**Focus:** `/new-implementation` gate as primary workflow
**Change log v3.4:** Agent-agnostic architecture — replaced pi-mono SDK dependency with pluggable CLI backend adapters (cli-claude, cli-codex, cli-gemini). Added AgentBackend interface, backend registry, per-step backend selection via gate YAML, CLI flag mapping reference, and SDK adapter extension path.

---

## 1. Core Concepts

### 1.1 Gates

A **gate** is a named entry point into the system. Each gate maps to exactly one workflow. Gates are invoked via slash commands in Slack (and later other channels).

```
/new-implementation    → Implementation workflow (PRIMARY — detailed below)
/investigate-bug       → Bug/vulnerability investigation workflow (future)
/research-kb           → Knowledge base research workflow (future)
/support-ticket        → Support ticket triage workflow (future)
/live-state            → Live system state query workflow (future)
```

Each gate owns:
- A workflow definition (strict sequence of steps)
- An execution config per step (agent session, script, or tool call)
- Validation rules and approval checkpoints
- Its own YAML config file

Gates are the only way work enters the system. Even cron jobs reference a gate.

### 1.2 Tasks and Subtasks

The system has two layers: **tasks** and **subtasks**.

```
TASK QUEUE (sequential, one at a time)
┌─────────────────────────────────────────────────┐
│ Task #1: "Implement balanceOwner redemption fix" │ ← ACTIVE
│ Task #2: "Add staking rewards calculation"       │ ← PENDING
│ Task #3: [CRON] Weekly security scan             │ ← PENDING
│ Task #4: "Refactor deposit flow"                 │ ← PENDING
└─────────────────────────────────────────────────┘

SUBTASK LIST (temporary, belongs to active task only)
┌─────────────────────────────────────────────────┐
│ ✓ 1. Load/create planning file                  │ ← DONE
│ ✓ 2. Restructure planning                       │ ← DONE
│ ● 3. Find similar historical tasks              │ ← ACTIVE
│ ○ 4. Adjust planning based on findings          │ ← PENDING
│ ○ 5. Prime codebase structure                   │ ← PENDING
│ ○ 6. Prime knowledge base                       │ ← PENDING
│ ○ 7. Prime guidelines                           │ ← PENDING
│ ○ 8. Create implementation tasks                │ ← PENDING
│ ○ 9. Batch implement                            │ ← PENDING
│ ○ 10. Commit and draft PR                       │ ← PENDING
└─────────────────────────────────────────────────┘
```

**Rules:**

1. Tasks execute **one at a time, sequentially**. No parallel tasks.
2. When a task starts, its gate's workflow generates a **subtask list**.
3. Subtasks execute **sequentially** within their list.
4. Only **one subtask list exists at any time** — it belongs to the active task.
5. When all subtasks complete, the task is marked done. The subtask list is archived.
6. The system advances to the next task and generates a new subtask list.
7. Cron jobs insert tasks into the same queue at their scheduled position.
8. Users can add tasks to the queue at any time. New tasks go to the back (or at a priority position).

### 1.3 Task Lifecycle

```
SUBMITTED → QUEUED → ACTIVE → SUBTASKS_RUNNING → COMPLETED
                                    │
                                    ├→ PAUSED (waiting for human input)
                                    ├→ FAILED (retryable)
                                    └→ ABORTED (manual cancel)
```

### 1.4 Subtask Lifecycle

```
PENDING → ACTIVE → COMPLETED
                      │
                      ├→ NEEDS_INPUT (human discussion required)
                      ├→ FAILED (retry or escalate)
                      └→ SKIPPED (if optional and conditions met)
```

### 1.5 Step Execution Types

Subtasks are polymorphic — each step declares an **execution type** that the subtask runner dispatches to.

```
EXECUTION TYPES:

agent   → AI model session via a pluggable backend. The backend
          determines how the model is invoked (CLI subprocess, SDK
          call, or raw API). One model, one prompt, one output.
          Used for: planning, research, review — tasks where a single
          LLM call with tools is sufficient.
          Backends: cli-claude, cli-codex, cli-gemini (+ future SDK adapters)

script  → External process (Python/shell) that runs its own agent
          orchestration internally. Receives context via stdin JSON,
          returns results via stdout JSON. May spawn multiple agents,
          use any framework, call any API.
          Used for: batch implementation (existing TDD pipeline),
          knowledge base priming, ACP consensus harness.

tool    → Direct TypeScript function call within the Bees process.
          No subprocess, no agent. Pure logic.
          Used for: file format conversion, git operations,
          notification dispatch, validation checks.
```

The **task executor loop does not change** regardless of execution type. It's always a for-loop iterating through steps. What changes is what happens inside each step.

```typescript
async function runSubtask(subtask: Subtask, step: StepDefinition, context: StepContext): Promise<StepOutput> {
  switch (step.execution.type) {
    case "agent":
      const backend = resolveAgentBackend(step.execution.config.backend);
      return await backend.run(step.execution.config, context);
    case "script":
      return await runScript(step.execution.command, step.execution.env, context);
    case "tool":
      return await runTool(step.execution.module, step.execution.function, context);
  }
}
```

### 1.6 Agent-Agnostic Architecture

Bees does **not** depend on any single AI agent SDK. Instead, the agent runner uses a **backend adapter pattern** that decouples orchestration from model execution.

```
                      AgentBackend interface
                 run(config, context) → StepOutput
                            │
           ┌────────────────┼────────────────┐
           │                │                │
    ┌──────┴──────┐  ┌─────┴──────┐  ┌──────┴──────┐
    │ CLIBackend  │  │ SDKBackend │  │ APIBackend  │
    │             │  │            │  │             │
    │ Spawns CLI  │  │ In-process │  │ Direct HTTP │
    │ subprocess  │  │ SDK call   │  │ to model API│
    │ (claude,    │  │ (future)   │  │ (future)    │
    │  codex,     │  │            │  │             │
    │  gemini)    │  │            │  │             │
    └─────────────┘  └────────────┘  └─────────────┘
```

**Why CLI-first:**

The CLI backend is the default and recommended starting point. It provides:

1. **Agent agnosticism** — Any AI model that ships a CLI works: `claude`, `codex`, `gemini`, or future CLIs. No vendor lock-in.
2. **Proven pattern** — The project already uses CLI-based model dispatch (see `cmd-call-model`) with file-based I/O, state flags, and background execution.
3. **Unified subprocess model** — The `agent` runner uses the same subprocess infrastructure as the `script` runner, reducing code surface.
4. **Zero SDK dependencies** — No `@anthropic-ai/sdk`, no `@mariozechner/pi-coding-agent`, no `openai`. Bees owns its orchestration fully.
5. **Swap backends per step** — Gate YAML declares the backend per step. One workflow can use Claude for planning and Codex for implementation.

**CLI Backend execution contract:**

```
INPUT:   Prompt written to temp file
OUTPUT:  Model response captured from stdout → output file
STATE:   Flag files (pending/completed/failed) for async tracking
TIMEOUT: Process kill after configured timeoutMs
EXIT 0:  Success — read output file
EXIT !0: Failure — capture stderr for error context
```

**SDK Backend (future path):**

When tighter integration is needed (streaming, in-process tool execution, multi-turn), an SDK adapter can be added without changing the dispatcher, gate YAML, or executor. The interface is the same — only the implementation changes:

```typescript
interface AgentBackend {
  readonly name: string;
  run(config: AgentConfig, context: StepContext): Promise<StepOutput>;
}

// CLI backend (default — ships with Bees)
class CLIAgentBackend implements AgentBackend {
  readonly name = "cli";
  async run(config: AgentConfig, context: StepContext): Promise<StepOutput> {
    // Write prompt to temp file
    // Spawn CLI process (claude, codex, gemini)
    // Wait for completion or timeout
    // Read output file → StepOutput
  }
}

// SDK backend (future — opt-in per step)
class AnthropicSDKBackend implements AgentBackend {
  readonly name = "anthropic-sdk";
  async run(config: AgentConfig, context: StepContext): Promise<StepOutput> {
    // Import @anthropic-ai/claude-agent-sdk
    // Create session, execute, return StepOutput
  }
}
```

**Backend resolution:**

```typescript
function resolveAgentBackend(backend?: string): AgentBackend {
  // Default: CLI backend based on model provider prefix
  // Explicit: "cli-claude", "cli-codex", "cli-gemini", "anthropic-sdk", etc.
  const registry: Record<string, AgentBackend> = {
    "cli-claude": new CLIAgentBackend("claude"),
    "cli-codex": new CLIAgentBackend("codex"),
    "cli-gemini": new CLIAgentBackend("gemini"),
    // Future: "anthropic-sdk": new AnthropicSDKBackend(),
    // Future: "openai-sdk": new OpenAISDKBackend(),
  };
  return registry[backend ?? inferBackendFromModel(config.model)];
}
```
```

**Script contract:**

```
STDIN   → JSON { workspace, taskPayload, steps: { [stepId]: output }, humanInput? }
STDOUT  → JSON { output: string, output_files: string[], cost?: CostData }
STDERR  → Progress lines (streamed to Slack thread in real time)
EXIT 0  → Success
EXIT 1  → Failure (retry)
EXIT 2  → Needs human input (pause)
```

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                  INPUT ADAPTERS                      │
│            Slack  │  (future channels)               │
└──────────────────┬──────────────────────────────────┘
                   │ gate + payload
                   ▼
┌─────────────────────────────────────────────────────┐
│                 GATE ROUTER                          │
│  Auto-discovers YAML files in gates/ directory       │
│  Validates gate command                              │
│  Loads gate config (workflow + agents)                │
│  Creates Task → pushes to queue                      │
└──────────────────┬──────────────────────────────────┘
                   │
          ┌────────┴────────┐
          ▼                 ▼
┌──────────────┐  ┌──────────────────────┐
│  TASK QUEUE  │  │   CRON SCHEDULER     │
│  (BullMQ)    │←─│   (BullMQ repeat)    │
│  Sequential  │  │   Injects into queue │
└──────┬───────┘  └──────────────────────┘
       │ next task
       ▼
┌─────────────────────────────────────────────────────┐
│              TASK EXECUTOR                            │
│  for-loop: reads gate YAML, iterates steps           │
│  Deterministic. No LLM decisions.                    │
│  Handles pause/resume for human interaction.          │
└──────────────────┬──────────────────────────────────┘
                   │ per subtask
                   ▼
┌─────────────────────────────────────────────────────┐
│              SUBTASK DISPATCHER                      │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │  agent   │  │  script  │  │   tool   │          │
│  │          │  │          │  │          │          │
│  │ Backend  │  │ Python/  │  │ TS func  │          │
│  │ Adapter  │  │ shell    │  │ in-proc  │          │
│  │ (CLI/SDK)│  │ process  │  │ call     │          │
│  └────┬─────┘  └──────────┘  └──────────┘          │
│       │                                              │
│       ├─ cli-claude  (claude CLI subprocess)         │
│       ├─ cli-codex   (codex CLI subprocess)          │
│       ├─ cli-gemini  (gemini CLI subprocess)         │
│       └─ (future: SDK adapters)                      │
│                     │                                │
│                     │ (may spawn its own agents)     │
│                     ▼                                │
│          ┌─────────────────────┐                    │
│          │ Existing pipelines: │                    │
│          │ • TDD 4-agent flow  │                    │
│          │ • KB digester       │                    │
│          │ • ACP consensus     │                    │
│          └─────────────────────┘                    │
└─────────────────────────────────────────────────────┘
```

---

## 3. `/new-implementation` Workflow — Full Specification

This is the primary gate. The workflow has **10 steps**, each becoming a subtask.

### Step 1: Planning File Check

```yaml
step: 1
id: planning_check
name: "Planning File Check"
execution:
  type: agent
  config:
    # backend: cli-claude (auto-resolved from anthropic/ prefix)
    model: anthropic/claude-haiku-4-5
    effort: min
    tools: [read]
    permissions: read-only
    skills: []
    timeoutMs: 30000
behavior: |
  Check if the task submission includes an attached planning file
  or references an existing planning document.

  IF a planning file is provided:
    - Parse and extract its contents
    - Set flag: existing_plan = true
    - Output: raw plan content + source format

  IF no planning file:
    - Set flag: existing_plan = false
    - Output: confirmation that no plan exists
```

### Step 2: Create / Restructure Planning

```yaml
step: 2
id: create_planning
name: "Create / Restructure Planning"
execution:
  type: agent
  config:
    model: anthropic/claude-sonnet-4-20250514
    effort: high
    tools: [read, write, bash]
    permissions: workspace-write
    skills: [tbtc-architecture, planning-format]
    timeoutMs: 300000
behavior: |
  IF existing_plan == true:
    - Read the provided plan
    - Restructure into Bees planning format
    - Preserve all original intent
    - Flag ambiguities for step 3

  IF existing_plan == false:
    - Gather from the task description
    - Ask clarifying questions if critical info is missing
      (subtask → NEEDS_INPUT)
    - Generate a complete plan in Bees format

  OUTPUT FILE: .bees/planning.md
```

**Bees Planning Format:**

```markdown
# Planning: [Title]

## Objective
One sentence describing what this implementation achieves.

## Context
Why this change is needed. Link to TIP, issue, or discussion.

## Scope
### In Scope
- ...
### Out of Scope
- ...

## Acceptance Criteria
- [ ] Criterion 1 (testable)
- [ ] Criterion 2 (testable)

## Technical Approach
High-level description of the approach.

## Files Affected (estimated)
- `src/...` — reason
- `test/...` — reason

## Risks & Unknowns
- Risk 1 — mitigation
- Unknown 1 — how to resolve

## Definition of Done
- [ ] All acceptance criteria met
- [ ] forge build passes
- [ ] forge test passes (new + existing)
- [ ] Code reviewed
- [ ] PR drafted with description
```

### Step 3: Historical Similarity Search & Solution Path

```yaml
step: 3
id: historical_search
name: "Find Similar Tasks & Confirm Solution Path"
execution:
  type: agent
  config:
    model: anthropic/claude-sonnet-4-20250514
    effort: high
    tools: [read, bash, grep, find]
    permissions: read-only
    skills: [tbtc-architecture, git-archaeology]
    timeoutMs: 300000
behavior: |
  1. SEARCH git history for similar changes
  2. SEARCH codebase for existing patterns
  3. COMPILE findings (past tasks, patterns to follow/avoid)
  4. PROPOSE definition of done
  5. PRESENT to user → subtask enters NEEDS_INPUT

  OUTPUT FILE: .bees/solution-path.md
  OUTPUT FILE: .bees/definition-of-done.md
```

### Step 4: Adjust Planning

```yaml
step: 4
id: adjust_planning
name: "Adjust Planning Based on Solution Path"
execution:
  type: agent
  config:
    model: anthropic/claude-sonnet-4-20250514
    effort: high
    tools: [read, write]
    permissions: workspace-write
    skills: [planning-format]
    timeoutMs: 180000
behavior: |
  Read planning.md + solution-path.md + definition-of-done.md + user feedback.
  Update planning.md with refined approach, updated files affected,
  adjusted definition of done. Mark plan as APPROVED.

  OUTPUT FILE: .bees/planning.md (updated, APPROVED)
```

### Step 5: Prime Codebase Structure

```yaml
step: 5
id: prime_codebase
name: "Prime Codebase Structure"
execution:
  type: agent
  config:
    model: anthropic/claude-sonnet-4-20250514
    effort: high
    tools: [read, bash, grep, find, ls]
    permissions: read-only
    skills: [tbtc-architecture]
    timeoutMs: 300000
behavior: |
  1. MAP relevant code structure (files from plan + one level of deps)
  2. DOCUMENT current state (file tree, key functions, data flows)
  3. IDENTIFY constraints (Solidity version, storage layout, gas paths)

  OUTPUT FILE: .bees/codebase-context.md
```

### Step 6: Prime Knowledge Base

```yaml
step: 6
id: prime_knowledge
name: "Prime Knowledge Base"
execution:
  type: script
  command: "python scripts/prime_knowledge.py"
  env:
    ANTHROPIC_API_KEY: "{{env.ANTHROPIC_API_KEY}}"
  timeoutMs: 300000
input_files:
  - .bees/planning.md
  - .bees/codebase-context.md
output_files:
  - .bees/knowledge-context.md
behavior: |
  Python script that runs its own agent pipeline internally:
  1. Classify which knowledge domains are relevant (Haiku, cheap)
  2. For each domain, load source material and digest with an agent
  3. Check for relevant audit findings (Trail of Bits items)
  4. Check for relevant TIPs and governance context
  5. Compile into a single knowledge context file

  The script owns its own agent orchestration.
  Bees only sees input files → output files.
```

### Step 7: Prime Guidelines

```yaml
step: 7
id: prime_guidelines
name: "Prime Guidelines"
execution:
  type: agent
  config:
    model: anthropic/claude-haiku-4-5
    effort: min
    tools: [read]
    permissions: read-only
    skills: [solidity-patterns, foundry-tooling, tbtc-conventions]
    timeoutMs: 60000
behavior: |
  Compile implementation guidelines:
  1. Coding conventions (style, naming, error handling, NatSpec)
  2. Testing conventions (structure, patterns, fuzzing, fork tests)
  3. Commit and PR conventions

  OUTPUT FILE: .bees/guidelines.md
```

### Step 8: Create Implementation Tasks

```yaml
step: 8
id: create_tasks
name: "Create Implementation Tasks"
execution:
  type: agent
  config:
    model: anthropic/claude-sonnet-4-20250514
    effort: high
    tools: [read, write]
    permissions: workspace-write
    skills: [planning-format, tbtc-architecture]
    timeoutMs: 300000
behavior: |
  Read all primed context files.
  Break the plan into atomic implementation tasks.

  Each task: small (1-3 file changes), self-contained (compiles/tests
  after this task alone), ordered (builds on previous), linked to
  acceptance criteria.

  OUTPUT FILE: .bees/implementation-tasks.md
  → Present to user for approval → subtask enters NEEDS_INPUT
```

### Step 9: Batch Implement

**This step delegates to the existing TDD pipeline.**

```yaml
step: 9
id: batch_implement
name: "Batch Implement"
execution:
  type: script
  command: "python scripts/bees_batch_bridge.py"
  env:
    ANTHROPIC_API_KEY: "{{env.ANTHROPIC_API_KEY}}"
  timeoutMs: 3600000  # 60 min
input_files:
  - .bees/implementation-tasks.md
  - .bees/codebase-context.md
  - .bees/knowledge-context.md
  - .bees/guidelines.md
output_files:
  - .bees/implementation-log.md
```

**What happens inside `bees_batch_bridge.py`:**

```
┌─────────────────────────────────────────────────┐
│ bees_batch_bridge.py                             │
│                                                  │
│ 1. Read .bees/implementation-tasks.md            │
│ 2. Convert to T-XXX.md files in MB format        │
│    (Memory Bank task format with:                │
│     Task ID, Status, Dependencies,               │
│     Project Source Path, acceptance criteria,     │
│     Required Files for Implementation)           │
│ 3. Set up TD directory structure                 │
│ 4. Write planning.md for the TD cycle            │
│                                                  │
│ 5. Delegate to existing pipeline:                │
│    ┌──────────────────────────────┐              │
│    │ run_batch.py (DAG executor)  │              │
│    │                              │              │
│    │ For each T-XXX in topo order:│              │
│    │   ┌────────────────────────┐ │              │
│    │   │ mb-dev-implement       │ │              │
│    │   │ (4-agent TDD workflow) │ │              │
│    │   │                        │ │              │
│    │   │ Phase 0: pre-implementer│ │             │
│    │   │   (Opus, strategy+env) │ │              │
│    │   │ Phase 1: tdd-implementer│ │             │
│    │   │   (Opus, RED phase)    │ │              │
│    │   │ Phase 2: coder         │ │              │
│    │   │   (Opus, GREEN phase)  │ │              │
│    │   │ Phase 3: coder         │ │              │
│    │   │   (Opus, REFACTOR)     │ │              │
│    │   │ Phase 4: tdd-implementer│ │             │
│    │   │   (Opus, VALIDATION)   │ │              │
│    │   └────────────────────────┘ │              │
│    │                              │              │
│    │ Halts on first failure.      │              │
│    │ Skips completed tasks.       │              │
│    └──────────────────────────────┘              │
│                                                  │
│ 6. Collect results from task artifacts           │
│ 7. Write .bees/implementation-log.md             │
│ 8. Output JSON to stdout                         │
└─────────────────────────────────────────────────┘
```

**The existing agents are unchanged:**

| Agent | Role | Model | Input | Output |
|-------|------|-------|-------|--------|
| `pre-implementer` | Strategy + env setup (branch, nvm, deps) | Opus | T-XXX.md | T-XXX-pre-implementation.md (400-600 lines) |
| `tdd-implementer` | RED phase (failing tests) + VALIDATION | Opus | T-XXX.md + pre-impl | T-XXX-artifact-red-phase.md, T-XXX-artifact-summary.md |
| `coder` | GREEN phase (minimal impl) + REFACTOR | Opus | T-XXX.md + pre-impl | T-XXX-artifact-green-phase.md, T-XXX-artifact-refactor-phase.md |
| `task-manager` | Status + checkbox updates | — | Task ID + status | Updates T-XXX.md in place |

**DAG execution** (from `run_batch.py`): Tasks are topologically sorted by dependencies. Each runs in its own `claude -p` subprocess with fresh 200K context. Completed tasks are skipped on re-run (resume support). Halts on first failure.

### Step 10: Commit and Draft PR

```yaml
step: 10
id: commit_and_pr
name: "Commit and Draft PR"
execution:
  type: agent
  config:
    model: anthropic/claude-sonnet-4-20250514
    effort: high
    tools: [read, bash]
    permissions: workspace-write
    skills: [tbtc-conventions, git-workflow]
    timeoutMs: 180000
behavior: |
  1. Review implementation log
  2. Stage changes (exclude .bees/ directory)
  3. Commit with conventional commit format
     - Committer: bees-bot (configured in workspace git config)
     - Add Co-authored-by trailer with requesting user's identity
     - Add Requested-by trailer with Slack context
  4. Push to feature branch (bees/<task-id>-<slug>)
  5. Draft PR via gh CLI or GitHub API using GITHUB_TOKEN:
     - Opened by: bees-bot
     - Title: conventional format matching main commit
     - Body: summary, acceptance criteria checklist, test results,
       cost, link to Slack thread
     - Reviewers: from team configuration
     - Labels: appropriate for change type
  6. Notify user with PR link and summary

  OUTPUT: PR URL + summary message to Slack
```

---

## 4. Gate Configuration Format

### 4.1 YAML Schema Specification

```yaml
# ─────────────────────────────────────────────────────
# GATE DEFINITION
# File: gates/<gate-id>.yaml
# ─────────────────────────────────────────────────────

gate:                                    # REQUIRED — gate metadata
  id: string                             # REQUIRED — unique identifier, lowercase, hyphens only
  name: string                           # REQUIRED — human-readable display name
  command: string                        # REQUIRED — slash command (e.g., /new-implementation)
  description: string                    # REQUIRED — one-line description shown in /help
  enabled: boolean                       # OPTIONAL — default: true. Set false to disable without deleting.

input:                                   # REQUIRED — what the user provides when invoking the gate
  required:                              # REQUIRED — at least one required field
    - <field-name>: string               #   field name → description of what it is
  optional:                              # OPTIONAL — additional fields the user can provide
    - <field-name>: string               #   field name → description with default if applicable

workflow:                                # REQUIRED — defines execution order and human gates
  steps:                                 # REQUIRED — ordered list of step IDs (references keys in `steps:`)
    - string                             #   executed sequentially, top to bottom
    - string
    - ...

  human_checkpoints:                     # OPTIONAL — pause points for human interaction
    - after: string                      # REQUIRED — step ID after which to pause
      action: string                     # REQUIRED — one of: discuss_and_confirm, approve_or_adjust
      message: string                    # REQUIRED — message shown to user in Slack
      timeout_hours: number              # OPTIONAL — default: 4. Auto-unblock queue after this.

steps:                                   # REQUIRED — step definitions, keyed by step ID
  <step-id>:                             # key must match an entry in workflow.steps
    execution:                           # REQUIRED — how this step runs
      type: string                       # REQUIRED — one of: agent, script, tool

      # ── IF type: agent ──
      config:                            # REQUIRED for agent type
        backend: string                  # OPTIONAL — agent backend adapter.
                                         #   Default: auto-resolved from model provider prefix.
                                         #   CLI backends: cli-claude, cli-codex, cli-gemini
                                         #   Future SDK backends: anthropic-sdk, openai-sdk
                                         #   If omitted, "anthropic/*" → cli-claude, "openai/*" → cli-codex, etc.
        model: string                    # REQUIRED — provider/model-id (e.g., anthropic/claude-sonnet-4-20250514)
        effort: string                   # OPTIONAL — model effort level. Maps to CLI flags:
                                         #   claude: --effort (min, low, medium, high, max)
                                         #   codex: -c model_reasoning_effort= (low, medium, high, xhigh)
                                         #   gemini: (not supported, ignored)
                                         #   Default: high
        tools: [string]                  # REQUIRED — list of tools the agent can use
                                         #   built-in: read, write, edit, bash, grep, find, ls
        permissions: string              # OPTIONAL — agent permission level.
                                         #   "read-only" | "workspace-write" | "full-access"
                                         #   Maps to CLI permission flags per backend.
                                         #   Default: "workspace-write"
        skills: [string]                 # OPTIONAL — skill directory names to load from skills/
        systemPrompt: string             # OPTIONAL — override default system prompt
        outputFormat: string             # OPTIONAL — "text" | "json". Default: "text"
        timeoutMs: number                # REQUIRED — max duration in milliseconds

      # ── IF type: script ──
      command: string                    # REQUIRED for script type — command to execute
      env:                               # OPTIONAL — environment variables passed to the script
        <KEY>: string                    #   supports {{env.VAR}} interpolation from .env
      timeoutMs: number                  # REQUIRED — max duration in milliseconds

      # ── IF type: tool ──
      module: string                     # REQUIRED for tool type — TS module path (relative to src/tools/)
      function: string                   # REQUIRED — exported function name to call
      args:                              # OPTIONAL — static arguments passed to the function
        <key>: any

    input_files:                         # OPTIONAL — files this step reads from the workspace
      - string                           #   relative to workspace root (e.g., .bees/planning.md)
    output_files:                        # OPTIONAL — files this step produces
      - string                           #   relative to workspace root
    behavior: |                          # OPTIONAL — human-readable description of what this step does
      Freeform markdown describing the step's logic.
      Not parsed by the executor — documentation only.
      Agents receive this as part of their prompt context.

workspace:                               # REQUIRED — workspace configuration for this gate
  repo: string                           # REQUIRED — GitHub org/repo (e.g., threshold-network/tbtc-v2)
  branch_prefix: string                  # OPTIONAL — default: "bees/". Prefix for feature branches.
  working_dir: string                    # OPTIONAL — default: ".bees/". Directory for artifacts.
  git_identity:                          # OPTIONAL — overrides global bees-bot identity
    name: string                         #   git user.name for this workspace
    email: string                        #   git user.email for this workspace
    token_env: string                    #   env var name holding the GitHub PAT
  artifacts:                             # OPTIONAL — list of artifact files this gate produces
    - string                             #   relative to working_dir
```

### 4.2 Field Reference

**`gate.id`** — Must be unique across all gate files. Used as the task's `gate` field in the queue. Convention: lowercase, hyphens, no spaces. Examples: `new-implementation`, `investigate-bug`, `research-kb`.

**`gate.command`** — The Slack slash command. Must start with `/`. Must be registered in the Slack app. Convention: matches `gate.id` with `/` prefix.

**`workflow.steps`** — Defines strict execution order. The executor iterates this list top-to-bottom. Every entry must have a matching key in `steps:`. No conditional branching — all steps run in order. If a step should sometimes be skipped, handle that inside the step's agent/script logic (output "nothing to do" and exit 0).

**`workflow.human_checkpoints`** — Each checkpoint pauses execution after the named step completes. The `action` field determines the Slack UX:
- `discuss_and_confirm`: Agent posts findings, user discusses in thread, sends `@bees continue`
- `approve_or_adjust`: Agent posts a proposal with Approve/Adjust/Cancel buttons

**`steps.<id>.execution.type`** — Determines which runner handles the step:
- `agent`: Dispatches to a pluggable agent backend. The `config.backend` field selects the adapter (default: auto-resolved from model provider prefix). CLI backends spawn the agent as a subprocess; SDK backends (future) call the SDK in-process.
- `script`: Spawns a subprocess. Receives context via stdin JSON, returns results via stdout JSON, streams progress via stderr.
- `tool`: Calls a TypeScript function in-process. No subprocess, no LLM. For pure logic like file conversion, validation, git operations.

**`steps.<id>.execution.config.backend`** — Agent-type only. Selects the agent execution backend. Available backends:
- `cli-claude`: Spawns `claude` CLI with `--dangerously-skip-permissions --model <model> --effort <effort> -p <prompt> --output-format <format>`. Default for `anthropic/*` models.
- `cli-codex`: Spawns `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --model <model> -c model_reasoning_effort=<effort>`. Default for `openai/*` models.
- `cli-gemini`: Spawns `gemini --approval-mode=yolo --model <model> -p <prompt> --output-format <format>`. Default for `google/*` models.
- Future: `anthropic-sdk`, `openai-sdk` — In-process SDK backends for tighter integration (streaming, multi-turn, programmatic tool use).
If omitted, the backend is inferred from the model provider prefix (the part before `/`).

**`steps.<id>.execution.config.tools`** — Agent-type only. List of tool names the agent is allowed to use. Available built-in tools: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. How tools are passed depends on the backend (CLI flags, SDK parameters, etc.).

**`steps.<id>.execution.config.permissions`** — Agent-type only. Controls what the agent is allowed to do in the workspace. `"read-only"` limits to read operations, `"workspace-write"` allows file modifications within the workspace, `"full-access"` grants unrestricted access (use with caution). Maps to backend-specific permission flags.

**`steps.<id>.execution.config.skills`** — Agent-type only. List of skill directory names. The runner loads `skills/<name>/SKILL.md` and injects it into the agent's prompt context. Skills are loaded on-demand, not upfront.

**`steps.<id>.input_files` / `output_files`** — Declarative. The executor doesn't enforce these (the agent/script reads/writes files on its own). They serve two purposes: documentation (what flows between steps) and validation (the executor can warn if an expected input file doesn't exist before running a step).

**`workspace.repo`** — The executor clones or creates a worktree from this repo when the task starts. All steps operate within this workspace.

**`workspace.artifacts`** — Listed for documentation and cleanup. When the task completes, artifacts are archived. The `.bees/` directory (or `working_dir`) is excluded from git commits.

### 4.3 Validation Rules

The gate loader validates on startup (or hot-reload):

```
ERRORS (gate will not load):
├── gate.id missing or empty
├── gate.command missing or doesn't start with /
├── workflow.steps is empty
├── workflow.steps references a step ID not defined in steps:
├── steps.<id>.execution.type is not one of: agent, script, tool
├── steps.<id>.execution.config missing when type is agent
├── steps.<id>.execution.command missing when type is script
├── steps.<id>.execution.module or function missing when type is tool
├── steps.<id>.execution.config.model missing when type is agent
├── steps.<id>.execution.config.tools missing when type is agent
├── steps.<id>.execution.timeoutMs or config.timeoutMs missing
├── human_checkpoints references a step ID not in workflow.steps
└── Duplicate gate.id or gate.command across gate files

WARNINGS (gate loads but issues flagged):
├── skills referenced in config.skills not found in skills/ directory
├── input_files listed but file doesn't exist (checked at step runtime, not load)
├── workspace.repo not accessible with current GITHUB_TOKEN
└── gate.enabled is false (gate loaded but won't respond to commands)
```

### 4.4 Example — `/new-implementation`

```yaml
# gates/new-implementation.yaml
gate:
  id: new-implementation
  name: "New Implementation"
  command: /new-implementation
  description: "Implement a new feature or change from a spec or description"
  enabled: true

input:
  required:
    - description: "What to implement (text or file attachment)"
  optional:
    - planning_file: "Existing planning document (any format)"
    - priority: "normal|high|critical (default: normal)"
    - branch: "Target branch name (auto-generated if omitted)"

workflow:
  steps:
    - planning_check
    - create_planning
    - historical_search
    - adjust_planning
    - prime_codebase
    - prime_knowledge
    - prime_guidelines
    - create_tasks
    - batch_implement
    - commit_and_pr

  human_checkpoints:
    - after: historical_search
      action: discuss_and_confirm
      message: "Solution path ready for review. Please confirm or adjust."
    - after: create_tasks
      action: approve_or_adjust
      message: "Implementation tasks ready. Approve to begin coding."

steps:
  planning_check:
    execution:
      type: agent
      config:
        # backend: cli-claude (auto-resolved from anthropic/ prefix)
        model: anthropic/claude-haiku-4-5
        effort: min
        tools: [read]
        permissions: read-only
        skills: []
        timeoutMs: 30000

  create_planning:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        effort: high
        tools: [read, write, bash]
        permissions: workspace-write
        skills: [tbtc-architecture, planning-format]
        timeoutMs: 300000

  historical_search:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        effort: high
        tools: [read, bash, grep, find]
        permissions: read-only
        skills: [tbtc-architecture, git-archaeology]
        timeoutMs: 300000

  adjust_planning:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        effort: high
        tools: [read, write]
        permissions: workspace-write
        skills: [planning-format]
        timeoutMs: 180000

  prime_codebase:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        effort: high
        tools: [read, bash, grep, find, ls]
        permissions: read-only
        skills: [tbtc-architecture]
        timeoutMs: 300000

  prime_knowledge:
    execution:
      type: script
      command: "python scripts/prime_knowledge.py"
      env:
        ANTHROPIC_API_KEY: "{{env.ANTHROPIC_API_KEY}}"
      timeoutMs: 300000
    input_files: [.bees/planning.md, .bees/codebase-context.md]
    output_files: [.bees/knowledge-context.md]

  prime_guidelines:
    execution:
      type: agent
      config:
        model: anthropic/claude-haiku-4-5
        effort: min
        tools: [read]
        permissions: read-only
        skills: [solidity-patterns, foundry-tooling, tbtc-conventions]
        timeoutMs: 60000

  create_tasks:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        effort: high
        tools: [read, write]
        permissions: workspace-write
        skills: [planning-format, tbtc-architecture]
        timeoutMs: 300000

  batch_implement:
    execution:
      type: script
      command: "python scripts/bees_batch_bridge.py"
      env:
        ANTHROPIC_API_KEY: "{{env.ANTHROPIC_API_KEY}}"
      timeoutMs: 3600000
    input_files:
      - .bees/implementation-tasks.md
      - .bees/codebase-context.md
      - .bees/knowledge-context.md
      - .bees/guidelines.md
    output_files:
      - .bees/implementation-log.md

  commit_and_pr:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        effort: high
        tools: [read, bash]
        permissions: workspace-write
        skills: [tbtc-conventions, git-workflow]
        timeoutMs: 180000

workspace:
  repo: "threshold-network/tbtc-v2"
  branch_prefix: "bees/"
  working_dir: ".bees/"
  git_identity:
    name: "bees-bot"
    email: "bees@t-labs.dev"
    token_env: "GITHUB_TOKEN"
  artifacts:
    - planning.md
    - solution-path.md
    - definition-of-done.md
    - codebase-context.md
    - knowledge-context.md
    - guidelines.md
    - implementation-tasks.md
    - implementation-log.md
```

### 4.5 Example — Minimal Gate (`/research-kb`)

A gate with only agent-type steps needs no scripts and minimal config:

```yaml
# gates/research-kb.yaml
gate:
  id: research-kb
  name: "Knowledge Base Research"
  command: /research-kb
  description: "Research a question against the codebase and knowledge base"
  enabled: true

input:
  required:
    - question: "What you want to know"

workflow:
  steps:
    - research
    - synthesize
  human_checkpoints: []

steps:
  research:
    execution:
      type: agent
      config:
        model: anthropic/claude-sonnet-4-20250514
        effort: high
        tools: [read, grep, find, ls, bash]
        permissions: read-only
        skills: [tbtc-architecture]
        timeoutMs: 300000
    behavior: |
      Deep research: read source files, trace call chains,
      check test files, look at git history. Cite files and lines.

  synthesize:
    execution:
      type: agent
      config:
        model: anthropic/claude-haiku-4-5
        effort: min
        tools: [read]
        permissions: read-only
        skills: []
        timeoutMs: 60000
    behavior: |
      Synthesize research into a clear, concise answer
      formatted for Slack.

workspace:
  repo: "threshold-network/tbtc-v2"
```

This gate needs zero new scripts, zero new skills (reuses `tbtc-architecture`), and is 40 lines of YAML.

### 4.6 Adding a New Gate — Checklist

To add a new gate (e.g., `/investigate-bug`):

```
1. CREATE  gates/investigate-bug.yaml         ← Required. Define steps + agent configs.
2. CREATE  skills/bug-triage/SKILL.md         ← If needed. Only if the gate needs domain
           skills/forensics/SKILL.md             knowledge not covered by existing skills.
3. CREATE  scripts/vuln_scanner.py            ← If needed. Only if a step is type: script.
4. REGISTER /investigate-bug in Slack app     ← Required. One API call or dashboard click.
5. RESTART Bees (or hot-reload)               ← Gate router discovers new YAML automatically.
```

**If the gate only uses `type: agent` steps with existing skills:** steps 2 and 3 are skipped. It's just the YAML file and the Slack registration.

**Skills are reusable across gates.** A skill written for `/new-implementation` (e.g., `tbtc-architecture`) can be referenced by any gate. Over time the skills library grows and new gates need fewer new skills.

**Scripts are gate-specific.** A script written for one gate's step is unlikely to be shared, since it encodes that gate's internal orchestration logic.

---

## 5. Existing Pipeline Integration

### 5.1 What Already Exists

The batch implementation system is a proven two-layer orchestrator:

**Outer layer — `run_batch.py`:**
- Reads T-XXX.md files from a tasks folder
- Parses Task ID, Status, Dependencies from each file
- Topologically sorts using Kahn's algorithm (dependency-aware levels)
- Executes tasks sequentially via `claude -p` subprocesses
- Skips tasks already marked "Done" (resume support on re-run)
- Halts on first failure, sends Telegram notification
- Sends success notification on completion

**Inner layer — `mb-dev-implement` (4-agent TDD pipeline per task):**

```
Phase 0:  pre-implementer    → Strategy + env setup (branch, nvm, deps)
Phase 0.1: task-manager      → Status update: In Progress
Phase 1:  tdd-implementer    → RED: create failing tests
Phase 1.1: task-manager      → Status update: checkboxes
Phase 2:  coder              → GREEN: minimal implementation
Phase 2.1: task-manager      → Status update: Testing
Phase 3:  coder              → REFACTOR: code quality
Phase 3.1: task-manager      → Status update: checkboxes
Phase 4:  tdd-implementer    → VALIDATION: verify all tests pass
Phase 4.1: task-manager      → Status update: Done or Re-opened
```

Each agent:
- Runs on Opus with max effort
- Gets fresh 200K context window (separate `claude -p` process)
- Reads T-XXX.md + T-XXX-pre-implementation.md for context
- Reads all Required Files IN-DEPTH before acting
- Writes structured artifact files (T-XXX-artifact-*.md)
- Reports status to orchestrator

**Task file format** (T-XXX.md) includes: Task ID, Status, Dependencies, Project Source Path, acceptance criteria, Required Files for Implementation (source code, test files, config, guidelines, knowledge).

### 5.2 Bridge Script — `bees_batch_bridge.py`

The bridge converts Bees's format to the existing pipeline's format and back.

```python
"""Bridge between Bees's implementation-tasks.md and the existing
Memory Bank TDD pipeline (run_batch.py + mb-dev-implement).

Receives: Bees context via stdin JSON
Produces: .bees/implementation-log.md
Delegates: All actual implementation to the existing pipeline
"""

import json, sys, re, os, subprocess
from pathlib import Path
from datetime import datetime, timezone


def main():
    context = json.loads(sys.stdin.read())
    workspace = Path(context["workspace"])
    bees_dir = workspace / ".bees"

    # 1. Read Bees's task list
    tasks_md = (bees_dir / "implementation-tasks.md").read_text()
    codebase_ctx = (bees_dir / "codebase-context.md").read_text()
    knowledge_ctx = (bees_dir / "knowledge-context.md").read_text()
    guidelines = (bees_dir / "guidelines.md").read_text()

    # 2. Set up Memory Bank TD structure
    mb_path = workspace / ".bees" / "memory-bank"
    td_number = 1
    td_path = mb_path / f"TD-{td_number}"
    tasks_dir = td_path / "tasks"
    tasks_dir.mkdir(parents=True, exist_ok=True)

    # 3. Write planning.md for the TD cycle
    planning = (bees_dir / "planning.md").read_text()
    (td_path / "planning.md").write_text(
        f"project_source_path: {workspace}\n\n{planning}"
    )

    # 4. Parse implementation-tasks.md → T-XXX.md files
    tasks = parse_implementation_tasks(tasks_md)
    for i, task in enumerate(tasks, 1):
        task_id = f"T-{i:03d}"
        task_md = format_task_file(
            task_id=task_id,
            task=task,
            project_source_path=str(workspace),
            dependencies=task.get("depends_on", []),
            codebase_context=codebase_ctx,
            knowledge_context=knowledge_ctx,
            guidelines=guidelines,
        )
        (tasks_dir / f"{task_id}.md").write_text(task_md)

    # 5. Delegate to existing pipeline
    print(f"[BRIDGE] Delegating {len(tasks)} tasks to run_batch.py", file=sys.stderr)
    result = subprocess.run(
        ["python", "scripts/mb-batch-implement/run_batch.py", str(tasks_dir)],
        capture_output=False,  # Let stderr stream to Bees for progress
        text=True,
        timeout=3600,
        env={**os.environ, "BEES_MODE": "1"},
    )

    # 6. Collect results
    log = collect_results(tasks_dir, tasks)
    (bees_dir / "implementation-log.md").write_text(log)

    # 7. Output to Bees
    json.dump({
        "output": log[:2000],
        "output_files": [".bees/implementation-log.md"],
        "cost": estimate_cost(tasks_dir),
    }, sys.stdout)

    sys.exit(0 if result.returncode == 0 else 1)


def parse_implementation_tasks(md: str) -> list[dict]:
    """Parse ## Task N: blocks from implementation-tasks.md."""
    tasks = []
    current = None
    for line in md.split("\n"):
        if line.startswith("## Task "):
            if current:
                tasks.append(current)
            current = {"title": line.split(":", 1)[1].strip() if ":" in line else line, "body": ""}
        elif current is not None:
            current["body"] += line + "\n"
    if current:
        tasks.append(current)
    return tasks


def format_task_file(task_id, task, project_source_path, dependencies, **ctx) -> str:
    """Format a task dict into T-XXX.md format expected by the TDD pipeline."""
    deps_str = ", ".join(dependencies) if dependencies else "None"
    return f"""# {task['title']}

**Task ID**: {task_id}
**Status**: Pending
**Dependencies**: {deps_str}
**Project Source Path**: {project_source_path}

## Description

{task['body']}

## Required Files for Implementation

Extracted from Bees context — see .bees/ artifacts for full details.
"""


def collect_results(tasks_dir: Path, tasks: list) -> str:
    """Read artifact files and compile implementation log."""
    log_lines = [f"# Implementation Log\n\nGenerated: {datetime.now(timezone.utc).isoformat()}\n"]
    for i, task in enumerate(tasks, 1):
        tid = f"T-{i:03d}"
        task_file = tasks_dir / f"{tid}.md"
        status = "Unknown"
        if task_file.exists():
            m = re.search(r"\*\*Status\*\*:\s*(.+)", task_file.read_text())
            if m:
                status = m.group(1).strip()
        log_lines.append(f"## {tid}: {task.get('title', 'Untitled')}\n**Status**: {status}\n")
    return "\n".join(log_lines)


def estimate_cost(tasks_dir: Path) -> dict:
    """Estimate cost from task artifacts (placeholder)."""
    return {"estimated_usd": 0, "note": "Cost tracking requires pipeline instrumentation"}


if __name__ == "__main__":
    main()
```

### 5.3 Migration Path

**Path A — Now (zero rewrite):**
Step 9 calls `bees_batch_bridge.py` which delegates to `run_batch.py` + `mb-dev-implement`. All existing agents, artifact files, TDD phases, and Telegram notifications work unchanged. Bees only wraps the outer loop. Agent steps use CLI backends (`claude`, `codex`, `gemini` CLIs).

**Path B — Later (SDK adapters for tighter integration):**
Add SDK backend adapters alongside the CLI backends. Benefits:
- Streaming per-phase progress to Slack (instead of waiting for CLI to finish)
- In-process tool execution (no CLI tool overhead)
- Multi-turn conversations within a single step
- Programmatic cost tracking per agent call (not just per task)
- Model rotation across tasks (multi-perspective passes)

**Path C — Later (multi-model per workflow):**
Use different backends and providers per step within the same workflow. Example:
- Steps 1, 7 (cheap/fast): `cli-gemini` with Gemini Flash
- Steps 2-5, 8, 10 (quality): `cli-claude` with Claude Sonnet
- Step 9 (batch implementation): unchanged script runner
This is already supported by the gate YAML — just change `model` and optionally `backend` per step.

**Trigger for Path B:** When you want Slack-level visibility into sub-step progress, or when CLI startup overhead becomes measurable for short-lived agent steps.

**Trigger for Path C:** When cost optimization matters, or when specific models outperform others for certain task types (e.g., Codex for code generation, Claude for planning).

---

## 6. GitHub Identity & Git Operations

### 6.1 Dedicated Machine User

Bees operates under a dedicated GitHub machine user account, separate from any team member's personal account.

| Field | Value |
|-------|-------|
| Account name | `t-labs-bees` (or `bees-bot`) |
| Email | `bees@t-labs.dev` (or shared alias) |
| Org membership | Write access to repos Bees operates on |
| Auth | Fine-grained PAT scoped to: `contents` (read/write), `pull_requests` (read/write) |
| Token storage | `.env` as `GITHUB_TOKEN` |

**Why a dedicated account:**
- Commits clearly show "bot wrote this" vs. "human wrote this" in PR reviews
- GitHub audit log separates bot actions from human actions
- Multiple team members trigger Bees — their requests shouldn't commit under one person's name
- Token rotation doesn't break anyone's personal workflow

### 6.2 Git Configuration Per Workspace

When the task executor creates a workspace (git worktree or clone), it configures the bot identity:

```bash
git config user.name "bees-bot"
git config user.email "bees@t-labs.dev"
```

This is set per-workspace (not global) so it doesn't affect any other git operations on the host.

### 6.3 Commit Attribution

Commits include a `Co-authored-by` trailer linking back to the team member who requested the task:

```
feat(staking): add rewards calculation

Implements staking rewards calculation per TIP-112.

Requested-by: @leonardo via Bees
Co-authored-by: Leonardo <leonardo@tnetworklabs.com>
```

- **Committer:** `bees-bot` (who made the change)
- **Co-author:** the requesting user (who asked for it)
- GitHub renders both in the PR UI

The requesting user's name and email are resolved from the `BeesUser` mapping (Slack user ID → GitHub identity).

### 6.4 PR Authorship

PRs are opened by `bees-bot` via `gh pr create` (GitHub CLI) or the GitHub API using `GITHUB_TOKEN`. The PR body includes:
- Which gate and task produced this PR
- Who requested it and when
- Summary of changes, acceptance criteria checklist, test results
- Cost of the run
- Link to the Slack thread for full conversation history

### 6.5 Branch Naming

Branches follow the pattern: `bees/<task-id>-<slugified-title>`

Example: `bees/task-0042-balanceowner-redemption-fix`

The pre-implementer agent (in the existing TDD pipeline) also creates branches. To avoid conflicts, the bridge script passes the Bees branch name through to the pipeline so both layers agree on the branch.

### 6.6 Token Rotation

Fine-grained PATs expire (max 1 year on GitHub). Options:
- **Now:** PAT with calendar reminder to rotate annually
- **Later:** Migrate to a GitHub App with installation tokens that auto-rotate

---

## 7. Task Queue Specification

### 7.1 Task Structure

```typescript
interface Task {
  id: string;
  gate: string;                  // "new-implementation", "investigate-bug", etc.
  status: TaskStatus;
  priority: "critical" | "high" | "normal" | "low";
  position: number;
  payload: Record<string, any>;
  requestedBy: string;
  sourceChannel: ChannelRef;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  cronJobId?: string;
  subtasks?: Subtask[];
  currentSubtask?: number;
  workspacePath?: string;
  cost: CostAccumulator;
  error?: string;
}

type TaskStatus = "queued" | "active" | "paused" | "completed" | "failed" | "aborted";

interface Subtask {
  id: string;
  stepId: string;
  name: string;
  executionType: "agent" | "script" | "tool";
  status: SubtaskStatus;
  startedAt?: Date;
  completedAt?: Date;
  output?: string;
  outputFiles?: string[];
  cost: CostAccumulator;
  error?: string;
  humanInput?: string;
}

type SubtaskStatus = "pending" | "active" | "needs_input" | "completed" | "failed" | "skipped";
```

### 7.2 Queue Behaviors

```
QUEUE RULES:
├── Tasks execute ONE AT A TIME
├── Order: priority first, then FIFO within same priority
├── "critical" jumps to front (does NOT interrupt active task)
├── Active task cannot be preempted, only cancelled
├── Cron-generated tasks enter at "normal" priority (configurable per cron)
└── User can reorder their own pending tasks

SUBTASK RULES:
├── Generated when parent task becomes active
├── Execute SEQUENTIALLY, in defined order
├── Each subtask gets the output of all prior subtasks as context
├── NEEDS_INPUT pauses the subtask (and therefore the task and queue)
├── User response in Slack thread resumes the subtask
├── Failed subtask: retry once, then pause for human decision
├── Only ONE subtask list exists at any time
└── Subtask list is archived when task completes

SCRIPT SUBTASK RULES (additional):
├── Script stderr streams to Slack thread as progress
├── Script may run for minutes to hours (batch_implement: up to 60 min)
├── Script exit code 2 triggers NEEDS_INPUT (pause for human)
├── Script timeout → task fails with timeout error
└── Script environment is isolated (own env vars, cwd)
```

---

## 8. Cron Jobs

```typescript
interface CronJob {
  id: string;
  name: string;
  schedule: string;              // Cron expression
  gate: string;                  // Which gate this cron uses
  payload: Record<string, any>;  // Fixed payload for the gate
  priority: "normal" | "high";
  enabled: boolean;
  createdBy: string;
  lastRun?: Date;
  nextRun?: Date;
}
```

**Slack commands:**

```
@bees cron add "0 9 * * MON" /investigate-bug "scan for new vulnerabilities in staking module"
@bees cron add "0 6 * * *" /research-kb "generate daily summary of open PRs"
@bees cron list
@bees cron delete <id>
@bees cron pause <id> / @bees cron resume <id>
```

When a cron fires, it creates a Task with `cronJobId` set. The task enters the queue like any other.

---

## 9. Human Interaction Model

### 9.1 NEEDS_INPUT State

1. Subtask status → `needs_input`
2. Parent task status → `paused`
3. Queue is **blocked**
4. Agent/script posts its question to the Slack thread
5. User responds in thread
6. User sends `@bees continue` or reacts with ✅ to resume
7. Subtask resumes with captured conversation as additional context

### 9.2 Approval Checkpoints

Configured per-gate. For `/new-implementation`:
- After step 3 (historical_search): discuss and confirm solution path
- After step 8 (create_tasks): approve implementation task list before coding begins

### 9.3 Pause Timeout

If no human response within configurable window (default: 4 hours), the task auto-pauses and moves to a "waiting" state that unblocks the queue. Can be resumed later and re-enters at original priority.

---

## 10. Slack Interface

### 10.1 Gate Commands

```
/new-implementation <description or planning file>
/investigate-bug <report>          (future)
/research-kb <question>            (future)
/support-ticket <ticket>           (future)
/live-state <query>                (future)
```

### 10.2 Management Commands

```
@bees status                       → Queue overview
@bees status <task-id>             → Task detail with subtask progress
@bees queue                        → Full queue listing
@bees cancel <task-id>             → Cancel a task
@bees priority <task-id> <level>   → Change task priority
@bees continue                     → Resume paused subtask (in thread)
@bees pause                        → Manually pause active task
@bees skip                         → Skip current subtask (in thread)
@bees retry                        → Retry failed subtask (in thread)
@bees cost                         → Cost report
@bees cost <task-id>               → Cost breakdown for a task
@bees cron <subcommand>            → Cron management
@bees help                         → Command list
```

### 10.3 Notification Flow

Each task gets its own Slack thread:

```
#bees-tasks channel:

🆕 @leonardo submitted: "Implement balanceOwner redemption fix"
   Gate: /new-implementation | Priority: normal | Position: #1
   │
   ├─ ▶ Task started
   ├─ ● Step 1/10: Planning File Check (agent) — no existing plan
   ├─ ● Step 2/10: Create Planning (agent) — generating...
   ├─ ✓ Step 2/10: done (45s, $0.12)
   ├─ ● Step 3/10: Historical Search (agent) — scanning git...
   ├─ ⏸ Step 3/10: needs your input
   │     "Found 3 similar implementations. [details]"
   ├─ 💬 @leonardo: "Use the pattern from PR #482"
   ├─ ✅ @leonardo: continue
   ├─ ✓ Step 4/10: Adjust Planning (agent) — done
   ├─ ● Step 5/10: Prime Codebase (agent) — mapping files...
   ├─ ✓ Step 5/10: done (2m, $0.45)
   ├─ ● Step 6/10: Prime Knowledge (script) — running pipeline...
   │     [stderr stream: "Digesting tbtc-security domain..."]
   │     [stderr stream: "Digesting tbtc-governance domain..."]
   ├─ ✓ Step 6/10: done (1m, $0.30)
   ├─ ✓ Step 7/10: Prime Guidelines (agent) — done (15s, $0.03)
   ├─ ● Step 8/10: Create Tasks (agent) — breaking plan into tasks...
   ├─ ⏸ Step 8/10: approval needed
   │     [📋 6 implementation tasks] [✅ Approve] [✏️ Adjust] [❌ Cancel]
   ├─ ✅ @leonardo: approved
   ├─ ● Step 9/10: Batch Implement (script) — TDD pipeline running...
   │     [stderr: "T-001 Phase 0: pre-implementer (strategy)..."]
   │     [stderr: "T-001 Phase 1: tdd-implementer (RED)..."]
   │     [stderr: "T-001 Phase 2: coder (GREEN)..."]
   │     [stderr: "T-001 Phase 3: coder (REFACTOR)..."]
   │     [stderr: "T-001 Phase 4: tdd-implementer (VALIDATION) → Done"]
   │     [stderr: "T-002 Phase 0: pre-implementer..."]
   │     ... (tasks 2-6) ...
   │     [stderr: "BATCH OK: All 6 tasks completed"]
   ├─ ✓ Step 9/10: done (28m, $18.40)
   ├─ ● Step 10/10: Commit & PR (agent) — pushing...
   ├─ ✓ Step 10/10: done — PR #512 drafted
   │
   └─ ✅ TASK COMPLETE
      PR: https://github.com/threshold-network/tbtc-v2/pull/512
      Duration: 38m | Cost: $21.24 | Files changed: 14
```

---

## 11. Technology Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Runtime | Node.js 22+ (ESM) | Native fetch, stable ESM, TypeScript-first tooling |
| Agent execution | CLI backend adapters (no SDK dependency) | Agent-agnostic: `claude`, `codex`, `gemini` CLIs via subprocess. Zero vendor lock-in. |
| Agent CLIs | `claude` (Anthropic), `codex` (OpenAI), `gemini` (Google) | Pre-installed on host. Each CLI handles its own auth, model access, and tool execution. |
| Task queue | BullMQ + Redis | Priority queue, cron, rate limiting built-in |
| Slack | `@slack/bolt` (Socket Mode) | No public URL needed |
| Persistence | SQLite (`better-sqlite3`) | Tasks, crons, costs, user mappings |
| Workflow defs | YAML files | Version-controlled, human-readable |
| Agent skills | Markdown files | Injected into agent prompt context. Format: `skills/<name>/SKILL.md` |
| Script runtime | Python 3.12+ (via `uv`) | Existing pipeline runs on Python |
| Existing pipeline | `run_batch.py` + `mb-dev-implement` | Proven TDD 4-agent system |
| Git identity | `bees-bot` GitHub machine user | Dedicated bot account for commits and PRs |
| GitHub CLI | `gh` | PR creation, label/reviewer assignment |
| Process manager | PM2 or systemd | Keep the service running |
| VPS | Single machine, 4 CPU / 8GB RAM | Redis + Node + agent sessions |

### 11.1 Agent Backend CLI Reference

Each CLI backend maps the gate YAML `config` fields to CLI-specific flags:

| Config Field | `cli-claude` | `cli-codex` | `cli-gemini` |
|-------------|-------------|------------|-------------|
| `model` | `--model <model-id>` | `--model <model-id>` | `--model <model-id>` |
| `effort` | `--effort <level>` | `-c model_reasoning_effort=<level>` | _(not supported)_ |
| `permissions` | `--dangerously-skip-permissions` (full) or default (restricted) | `--dangerously-bypass-approvals-and-sandbox` (full) | `--approval-mode=yolo` (full) |
| `outputFormat` | `--output-format text\|json` | `-o <file>` (file output) | `--output-format text` |
| `systemPrompt` | Prepended to `-p` prompt | Prepended to stdin | Prepended to `-p` prompt |
| `skills` | Loaded from `skills/<name>/SKILL.md`, appended to prompt | Same | Same |
| Prompt delivery | `-p "$(cat <prompt-file>)"` | `< <prompt-file>` (stdin) | `-p "$(cat <prompt-file>)"` |
| Output capture | stdout redirect to file | `-o <output-file>` | stdout redirect to file |
| Timeout | `kill -TERM` after `timeoutMs` | Same | Same |
| State tracking | Flag files: `pending-*.flag`, `completed-*.flag`, `failed-*.flag` | Same | Same |

**Model ID normalization:**

The gate YAML uses `provider/model-id` format (e.g., `anthropic/claude-sonnet-4-20250514`). The CLI backend strips the provider prefix and passes only the model ID to the CLI. If `backend` is explicitly set, the provider prefix is ignored for backend resolution.

```
anthropic/claude-sonnet-4-20250514  →  claude --model claude-sonnet-4-20250514
openai/gpt-5.4                      →  codex --model gpt-5.4
google/gemini-3.1-pro-preview       →  gemini --model gemini-3.1-pro-preview
```

---

## 12. Project Structure

```
bees/
├── package.json
├── tsconfig.json
├── .env
├── docker-compose.yml              # Redis
│
├── src/
│   ├── index.ts                    # Boot: adapters + queue + executor
│   │
│   ├── adapters/
│   │   ├── types.ts                # NormalizedMessage, ChannelRef
│   │   ├── adapter.ts              # Adapter interface
│   │   └── slack.ts                # Slack Bolt implementation
│   │
│   ├── gates/
│   │   ├── router.ts               # Gate command → config lookup
│   │   └── loader.ts               # YAML gate config loader
│   │
│   ├── queue/
│   │   ├── task-queue.ts           # BullMQ queue wrapper
│   │   ├── cron.ts                 # Cron job manager
│   │   └── types.ts                # Task, Subtask interfaces
│   │
│   ├── executor/
│   │   ├── task-executor.ts        # for-loop: dequeue → subtasks → run
│   │   ├── subtask-dispatcher.ts   # Routes to agent/script/tool runner
│   │   ├── script-runner.ts        # Subprocess execution (stdin/stdout/stderr)
│   │   ├── tool-runner.ts          # In-process TS function calls
│   │   ├── context-builder.ts      # Build prompt/stdin from prior outputs
│   │   └── human-interaction.ts    # NEEDS_INPUT / approval handling
│   │
│   ├── runners/
│   │   ├── types.ts                # AgentBackend interface, AgentConfig, registry
│   │   ├── registry.ts             # Backend registry + resolution (model prefix → backend)
│   │   ├── cli-backend.ts          # CLIAgentBackend: shared subprocess logic
│   │   │                           #   Handles: prompt file I/O, process spawn,
│   │   │                           #   timeout kill, output capture, state flags
│   │   ├── cli-claude.ts           # Claude CLI specifics (flag mapping, env vars)
│   │   ├── cli-codex.ts            # Codex CLI specifics (flag mapping, env vars)
│   │   ├── cli-gemini.ts           # Gemini CLI specifics (flag mapping, env vars)
│   │   └── prompt-builder.ts       # Assembles prompt: system + skills + context + user prompt
│   │
│   ├── persistence/
│   │   ├── db.ts                   # SQLite setup + migrations
│   │   ├── tasks.ts
│   │   ├── crons.ts
│   │   └── costs.ts
│   │
│   └── utils/
│       ├── logger.ts
│       └── config.ts
│
├── scripts/                        # Script-type step implementations
│   ├── bees_batch_bridge.py        # Bridge: Bees → existing TDD pipeline
│   ├── prime_knowledge.py          # KB priming with internal agents
│   ├── mb-batch-implement/         # Existing pipeline (copied/symlinked)
│   │   ├── run_batch.py
│   │   ├── parse_dag.py
│   │   └── check_status.py
│   └── agents/                     # Existing agent definitions
│       ├── pre-implementer.md
│       ├── tdd-implementer.md
│       ├── coder.md
│       └── mb-dev-implement.md
│
├── gates/                          # Gate definitions (YAML)
│   ├── new-implementation.yaml
│   ├── investigate-bug.yaml        # (stub)
│   ├── research-kb.yaml            # (stub)
│   ├── support-ticket.yaml         # (stub)
│   └── live-state.yaml             # (stub)
│
├── skills/                         # Skill files (markdown, injected into agent prompt)
│   ├── tbtc-architecture/SKILL.md
│   ├── tbtc-security/SKILL.md
│   ├── tbtc-governance/SKILL.md
│   ├── tbtc-conventions/SKILL.md
│   ├── solidity-patterns/SKILL.md
│   ├── foundry-tooling/SKILL.md
│   ├── planning-format/SKILL.md
│   ├── git-archaeology/SKILL.md
│   └── git-workflow/SKILL.md
│
└── tests/
    ├── executor/
    ├── queue/
    └── gates/
```

---

## 13. Execution Phases

### Phase 1: Skeleton (Week 1)

- [ ] Project scaffolding (Node.js, TS, ESM, BullMQ, Redis)
- [ ] Create `bees-bot` GitHub machine user, add to org, generate PAT
- [ ] Slack Bolt adapter — receive messages, send replies
- [ ] Gate router — parse `/new-implementation` command
- [ ] Task queue — push/dequeue with priority, sequential execution
- [ ] Task executor — for-loop through steps, generate subtask list
- [ ] Subtask dispatcher — route to agent/script/tool runner
- [ ] Agent backend adapter interface + registry (`src/runners/`)
- [ ] CLI agent backends — cli-claude, cli-codex, cli-gemini (subprocess spawn, flag mapping, output capture)
- [ ] Prompt builder — assemble system prompt + skills + context into prompt file
- [ ] Script runner — subprocess with stdin/stdout/stderr contract
- [ ] Tool runner — in-process TS function dispatch
- [ ] Workspace setup — git worktree creation with bees-bot identity
- [ ] Wire end to end: Slack → queue → single subtask → reply
- [ ] Test with a trivial 1-step gate (each backend: claude, codex, gemini)

### Phase 2: /new-implementation Workflow (Weeks 2-3)

- [ ] Implement steps 1-5, 7-8, 10 as agent subtasks
- [ ] Implement step 6 (prime_knowledge) as script subtask
- [ ] Build `bees_batch_bridge.py` for step 9
- [ ] Copy/symlink existing pipeline (`run_batch.py` + agents)
- [ ] Gate YAML config loading
- [ ] Context passing between subtasks (output → next input)
- [ ] Human interaction: NEEDS_INPUT, Slack thread capture, `@bees continue`
- [ ] Approval checkpoints with Slack interactive buttons
- [ ] Pause/resume and queue blocking logic
- [ ] Auto-timeout for paused tasks (4h)
- [ ] Write core skills: `planning-format`, `tbtc-architecture`, `solidity-patterns`, `foundry-tooling`
- [ ] Test against a real tBTC feature request

### Phase 3: Cron + Polish (Week 4)

- [ ] Cron scheduler (BullMQ repeatable jobs)
- [ ] Cron management Slack commands
- [ ] Cost tracking per task/subtask (agent sessions + script estimates)
- [ ] Queue status commands
- [ ] Task cancellation and manual pause
- [ ] Structured logging
- [ ] Error handling: subtask retry, dead letter, user notification
- [ ] Write remaining skills

### Phase 4: Team Rollout (Week 5)

- [ ] Deploy to VPS (PM2 + Redis + Slack bot)
- [ ] Onboard team (Viktoriia, Piotr, Maclane)
- [ ] Stub gate configs for future gates
- [ ] Monitor, tune timeouts, adjust agent configs
- [ ] Document: team usage guide, how to add gates, how to write skills

### Future Phases

- [ ] Additional gates with their own workflows
- [ ] Additional adapters (Telegram, Discord, email)
- [ ] Memory bank harness gate
- [ ] ACP consensus harness gate
- [ ] Path B: SDK backend adapters for streaming and in-process tool execution
- [ ] Path C: Multi-model workflows (Gemini for cheap steps, Claude for quality, Codex for code)
- [ ] Web dashboard for queue visualization
- [ ] Custom CLI backend adapter for self-hosted models (Ollama, vLLM)

---

## 14. Open Decisions

| # | Question | Options | Recommendation | Status |
|---|----------|---------|----------------|--------|
| 1 | Queue blocking on pause | Block vs. skip paused | Block initially, add timeout-skip later | Open |
| 2 | Workspace isolation | Shared repo vs. worktree | Worktree per task — avoids contention | Open |
| 3 | Approval UX | Buttons vs. text | Buttons (cleaner), text as fallback | Open |
| 4 | Context passing | Full output vs. summary | Full output, let agent filter | Open |
| 5 | Model per step | Fixed in YAML vs. dynamic | Fixed in YAML — deterministic | Open |
| 6 | Existing pipeline coupling | Symlink vs. copy vs. npm | Symlink for dev, copy for deploy | Open |
| 7 | Notification routing | Slack only vs. also Telegram | Slack only (Telegram via existing notify for pipeline) | Open |
| 8 | Bridge script format conversion | Strict T-XXX.md vs. simplified | Match existing format exactly to avoid pipeline changes | Open |
| 9 | Cost model | Pay-per-use vs. daily budget | Daily budget per team, alert at 80% | Open |
| 10 | GitHub auth | Machine user + PAT vs. GitHub App | PAT to start, GitHub App later for auto-rotation | Open |
| 11 | Agent execution | pi-mono SDK vs. CLI backends vs. vendor SDK | **DECIDED: CLI backend adapters.** No SDK dependency. Spawn `claude`/`codex`/`gemini` CLIs as subprocesses. Proven by existing `cmd-call-model` pattern. SDK adapters can be added later as optional backends without changing the dispatcher or gate YAML. | **Resolved** |
| 12 | Backend per step | Single backend vs. per-step backend | Per-step backend via YAML `config.backend` field. Default auto-resolved from model provider prefix. Enables multi-model workflows without code changes. | **Resolved** |
