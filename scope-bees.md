# Project Bees — Recipe-Orchestrated Agent Runtime

## Scope Document v4.0

**Codename:** Bees  
**Date:** 2026-04-05  
**Status:** Re-baselined planning  
**Primary recipe:** `/new-implementation`  
**Change log v4.0:** Replaced the old gate/linear-step/tool/skill authoring model with a recipe stage-graph model built around roles, registered scripts, an orchestrator agent, a deterministic worker, a global artifact registry, and an append-only run journal. The CLI worker contract is now standardized around `# Role`, `# Task`, and `# Output`.

---

## 1. Executive Summary

Bees is a Slack-first orchestration system for running real engineering workflows through a shared execution runtime.

The key architectural decision is:

- a **recipe** defines workflow topology
- an **orchestrator agent** decides what subtask should happen next
- a **deterministic worker** executes the queued subtask and records everything
- **scripts** are registered deterministic capabilities the orchestrator may use
- **roles** define how orchestrator and stage agents should behave
- **artifacts** and the **run journal** are the durable memory of each run

This model is designed to support all of the workflow types already present in the surrounding ecosystem:

- `/new-implementation`
- ACP consensus workflows
- Memory Bank project, TD, dev, review, and ops workflows
- operational monitoring workflows such as `tbtc-monitor`

The primary delivery target remains `/new-implementation`, but the architecture must not hardcode itself around that one recipe. The system should feel simple to author:

- add one `recipe.yaml`
- reuse or add `roles/`
- reuse or add registered `scripts/`

Everything else is runtime infrastructure.

---

## 2. Goals and Non-Goals

### 2.1 Goals

Bees should:

1. Let teams create new workflows without writing custom TypeScript orchestration for each one.
2. Keep the author-facing model simple: recipes, roles, and scripts.
3. Preserve deterministic execution and auditability even when an agent is making decisions.
4. Support human-in-the-loop workflows with pause, approval, resume, and timeout behavior.
5. Make every important output durable and traceable through artifact IDs and a journal.
6. Support one-shot CLI agent execution through Claude, Codex, and Gemini.
7. Reuse proven external pipelines through scripts instead of rewriting them immediately.
8. Preserve the existing `/new-implementation` planning behavior already implemented in the repo, then generalize from there.

### 2.2 Non-Goals

Bees should not:

1. Encode arbitrary logic in YAML.
2. Let the orchestrator invent commands, scripts, stages, or topology at runtime.
3. Depend on any single vendor SDK as the only execution path.
4. Require every deterministic helper to become a recipe stage.
5. Introduce a permanent second runtime beside the one already in the repo.
6. Optimize for per-task parallelism in the first stable runtime.
7. Hide history by mutating past stage executions instead of appending new task and subtask records.

---

## 3. Canonical Concepts

### 3.1 Recipes

A **recipe** is one complete workflow definition authored in `recipe.yaml`.

A recipe defines:

- its identity and trigger metadata
- its input contract
- its orchestrator config
- its canonical stage order
- its stage graph
- its required outputs and checkpoints

The recipe is the source of truth for topology, not the source of truth for immediate execution.

### 3.2 Roles

A **role** is reusable behavioral instruction text for an agent call.

Roles describe:

- what the agent is responsible for
- how the agent should reason
- what standards it should apply
- what it should avoid
- what shape of output it should produce

There are two role classes:

- **orchestrator roles**
- **stage roles**

`role` replaces the earlier `skill` language. `skill` is a legacy harness term and should not be used as the author-facing Bees concept going forward.

### 3.3 Registered Scripts

A **script** is a deterministic executable capability with a stable ID.

Scripts:

- are registered in a global catalog
- have input and output contracts
- expose safety metadata and timeout rules
- may be read-only or mutating
- may stream progress to Slack through stderr

Scripts are not embedded in recipes as raw shell commands. Recipes reference them by ID through `allowed_scripts`.

### 3.4 Orchestrator

The **orchestrator** is a first-class agent with its own config.

It reads:

- the current task state
- the current stage
- prior outputs
- artifact summaries
- recent run-journal entries
- the stage allowlist of scripts
- the global script catalog summary
- retry and action budgets

It decides:

- queue a stage agent run
- queue a script run
- retry a stage
- revisit a prior allowed stage
- advance to another allowed stage
- pause for human input
- finish the run
- fail the run

The orchestrator does not execute anything directly.

### 3.5 Deterministic Worker

The **deterministic worker** is the execution middle layer.

It:

- dequeues the next subtask
- resolves inputs
- renders prompts or script payloads
- invokes the selected runtime
- captures outputs and logs
- stores artifacts
- updates state
- appends journal events
- green-lights the next orchestrator evaluation when appropriate

It never decides what comes next on its own.

### 3.6 Tasks and Subtasks

A **task** is one recipe run.

A **subtask** is one queued work item inside that task.

Canonical subtask kinds:

- `orchestrator_eval`
- `stage_agent_run`
- `script_run`
- `resume_after_input`

The user sees one task thread. The runtime sees a sequence of subtasks under that task.

### 3.7 State, Artifacts, and Run Journal

**State** is small structured data carried through the run, such as:

- `current_stage_id`
- `approval_status`
- `attempt_count`
- `current_branch`
- `last_script_id`

An **artifact** is a durable file output stored by ID in a global artifact store.

The **run journal** is an append-only record of:

- orchestrator decisions
- subtask starts and finishes
- pauses and resumes
- errors and retries
- artifact registrations
- notifications

### 3.8 Bounded Control

The orchestrator has strong control, but not unlimited control.

It may:

- choose among allowed transitions
- retry within configured limits
- call registered scripts allowed for the current stage
- patch the next stage input

It may not:

- create new stages
- create new transitions
- call unknown scripts
- bypass recipe policies
- rewrite history

This is the central safety boundary of Bees.

### 3.9 Compatibility Note

The current codebase still contains older concepts such as:

- gates
- direct linear step execution
- `skills/`
- author-facing tool steps

Those are migration artifacts. The target external authoring model in this document is:

- `recipes/`
- `roles/`
- registered `scripts/`
- orchestrator decisions
- deterministic worker execution

---

## 4. Runtime Architecture

### 4.1 High-Level Architecture

```text
┌────────────────────────────────────────────────────────────────┐
│                         INPUT ADAPTERS                         │
│        Slack slash commands, thread replies, cron, future     │
└───────────────────────────────┬────────────────────────────────┘
                                │ trigger + payload
                                ▼
┌────────────────────────────────────────────────────────────────┐
│                    TRIGGER / RECIPE ROUTER                    │
│   Resolve trigger -> recipe ID -> validated recipe config     │
└───────────────────────────────┬────────────────────────────────┘
                                │ create task
                                ▼
┌────────────────────────────────────────────────────────────────┐
│                       GLOBAL TASK QUEUE                       │
│      One active task at a time in the baseline runtime        │
└───────────────────────────────┬────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────┐
│                          TASK STATE                           │
│ task record | per-task subtask queue | state | journal | refs │
└───────────────────────────────┬────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────┐
│                    DETERMINISTIC WORKER LOOP                  │
│    Dequeue subtask -> execute -> persist -> enqueue next      │
└───────────────┬───────────────────────┬────────────────────────┘
                │                       │
                │ orchestrator_eval     │ stage_agent_run / script_run
                ▼                       ▼
┌────────────────────────┐   ┌──────────────────────────────────┐
│   ORCHESTRATOR AGENT   │   │       EXECUTION ADAPTERS         │
│ role + full run ctx    │   │  CLI worker adapters | scripts   │
│ returns next decision  │   │  Claude | Codex | Gemini | etc.  │
└──────────────┬─────────┘   └─────────────────┬────────────────┘
               │ validated decision             │ results + logs
               └──────────────┬─────────────────┘
                              ▼
┌────────────────────────────────────────────────────────────────┐
│                ARTIFACT STORE + RUN JOURNAL                   │
│  durable IDs | raw outputs | mirrored files | event history   │
└────────────────────────────────────────────────────────────────┘
```

### 4.2 Control Boundaries

**Recipe owns topology**

- stages
- canonical order
- allowed transitions
- required checkpoints
- allowed scripts

**Orchestrator owns execution decisions**

- what to queue next
- whether more context is needed
- whether to retry or revisit
- whether to pause or finish

**Worker owns execution chores**

- input assembly
- prompt rendering
- spawn and capture
- parsing and normalization
- artifact registration
- journal appends
- state patch application

### 4.3 Runtime Loop

```typescript
async function runTask(task: Task): Promise<void> {
  if (!task.hasQueuedSubtasks()) {
    enqueue(task.id, {
      kind: "orchestrator_eval",
      stageId: task.currentStageId ?? task.startStageId,
    });
  }

  while (task.hasQueuedSubtasks()) {
    const subtask = dequeueNextSubtask(task.id);

    switch (subtask.kind) {
      case "orchestrator_eval":
        const decision = await evaluateOrchestrator(task, subtask);
        validateDecision(task.recipe, task.state, decision);
        applyDecision(task, decision);
        break;

      case "stage_agent_run":
        const stageResult = await runStageAgent(task, subtask);
        persistStageResult(task, subtask, stageResult);
        enqueueNextOrchestratorEvalIfNeeded(task, subtask, stageResult);
        break;

      case "script_run":
        const scriptResult = await runRegisteredScript(task, subtask);
        persistScriptResult(task, subtask, scriptResult);
        enqueueNextOrchestratorEvalIfNeeded(task, subtask, scriptResult);
        break;

      case "resume_after_input":
        applyCapturedHumanInput(task, subtask);
        enqueue(task.id, {
          kind: "orchestrator_eval",
          stageId: task.currentStageId,
        });
        break;
    }
  }
}
```

### 4.4 Why This Architecture Fits Current Workflow Types

#### ACP Consensus

ACP requires:

- repeated evaluation
- revisit loops
- stateful rounds
- multi-role agent behavior

This fits a recipe with:

- debate stages
- an orchestrator allowed to revisit or continue
- registered support scripts for counting or summarization

#### Memory Bank

Memory Bank is a workflow family, not one path.

This fits:

- many recipes
- many reusable roles
- many reusable scripts
- one shared runtime

#### tBTC Monitor

tBTC monitor is mostly deterministic.

This fits because:

- the recipe can expose a small set of operational stages
- the orchestrator can call the correct registered script
- a final stage agent may summarize or explain the results

---

## 5. Runtime Data Model

### 5.1 Task Model

```typescript
interface Task {
  id: string;
  recipeId: string;
  status: TaskStatus;
  priority: "critical" | "high" | "normal" | "low";
  requestedBy: BeesUserRef;
  sourceChannel: ChannelRef;
  trigger: TriggerRef;
  input: Record<string, unknown>;
  workspacePath?: string;
  runPath: string;
  currentStageId?: string;
  activeSubtaskId?: string;
  queuedSubtaskIds: string[];
  artifactIds: string[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  pausedAt?: Date;
  waitingSince?: Date;
  resumeDeadlineAt?: Date;
  error?: string;
}

type TaskStatus =
  | "queued"
  | "active"
  | "paused"
  | "waiting"
  | "completed"
  | "failed"
  | "aborted";
```

### 5.2 Subtask Model

```typescript
interface Subtask {
  id: string;
  taskId: string;
  kind: SubtaskKind;
  stageId?: string;
  status: SubtaskStatus;
  attempt: number;
  payload: Record<string, unknown>;
  output?: Record<string, unknown>;
  artifactIds: string[];
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

type SubtaskKind =
  | "orchestrator_eval"
  | "stage_agent_run"
  | "script_run"
  | "resume_after_input";

type SubtaskStatus =
  | "queued"
  | "active"
  | "needs_input"
  | "completed"
  | "failed"
  | "skipped";
```

### 5.3 Artifact Model

```typescript
interface Artifact {
  id: string;                     // e.g. art_01HV...
  taskId: string;
  subtaskId: string;
  label: string;                  // planning_doc, implementation_log, etc.
  format: "md" | "json" | "txt" | "log" | "bin";
  storagePath: string;            // runtime/artifacts/<artifact-id>/payload
  mirrorPaths?: string[];         // e.g. .bees/planning.md
  summary?: string;
  checksum?: string;
  createdAt: Date;
}
```

### 5.4 Run Journal Model

```typescript
interface JournalEntry {
  id: string;
  taskId: string;
  subtaskId?: string;
  type: JournalEventType;
  stageId?: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

type JournalEventType =
  | "task_created"
  | "subtask_queued"
  | "subtask_started"
  | "orchestrator_decision"
  | "decision_rejected"
  | "subtask_completed"
  | "subtask_failed"
  | "task_paused"
  | "task_resumed"
  | "task_waiting"
  | "task_completed"
  | "task_failed"
  | "artifact_registered"
  | "notification_sent";
```

### 5.5 Status Lifecycles

**Task**

```text
SUBMITTED -> QUEUED -> ACTIVE -> COMPLETED
                         |        |
                         |        -> FAILED
                         |
                         -> PAUSED -> WAITING -> ACTIVE
                         |
                         -> ABORTED
```

**Subtask**

```text
QUEUED -> ACTIVE -> COMPLETED
                  |     |
                  |     -> FAILED
                  |
                  -> NEEDS_INPUT
```

### 5.6 Queue Rules

#### Global task queue

- one active task at a time in the baseline runtime
- ordering is priority first, then FIFO inside a priority level
- a critical task may jump ahead of pending tasks but does not preempt the active task
- paused tasks do not block forever; timeout may move them to `waiting`

#### Per-task subtask queue

- each task owns an ordered internal subtask queue
- one active subtask at a time per task
- the orchestrator decides what new subtask is enqueued
- the worker executes subtasks strictly in queue order
- revisits and retries create new subtask records instead of mutating old ones

### 5.7 Artifact Storage Rule

All meaningful file outputs should be stored in the global artifact store by ID.

Recommended on-disk layout:

```text
runtime/
  artifacts/
    art_01HV.../
      payload
      metadata.json
  runs/
    task_01HV.../
      subtasks/
      logs/
      mirrors/
```

For compatibility, a recipe may request convenience mirrors such as:

- `.bees/planning.md`
- `.bees/codebase-context.md`

But the artifact ID remains authoritative.

---

## 6. Agent Execution Model

### 6.1 One-Shot CLI Worker Contract

The baseline Bees runtime uses one-shot CLI workers.

Each agent call, whether orchestrator or stage agent, is rendered as one prompt body:

```text
# Role
<resolved role text>

# Task
<resolved assignment, context, and success criteria>

# Output
<required output schema or output format>
```

That prompt body is then passed to the selected CLI worker:

- Claude CLI
- Codex CLI
- Gemini CLI

This is intentionally aligned with the CLI worker pattern already documented in `01-claude-filebin/docs/cli-workers.md`.

### 6.2 Orchestrator Config

Every recipe defines an orchestrator block.

Recommended fields:

```yaml
orchestrator:
  role: roles/orchestrators/implementation.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  permissions: workspace-write
  timeout_ms: 180000
  max_stage_retries: 2
  max_total_actions: 40
  max_script_calls_per_stage: 3
```

These settings belong to the recipe, not to the worker.

### 6.3 Orchestrator Input Context

Each `orchestrator_eval` should include:

- recipe metadata
- task metadata
- current stage
- canonical stage order
- allowed transitions from the current stage
- current stage allowlist of scripts
- global script catalog summary
- current state snapshot
- recent journal entries
- current artifact summaries
- most recent subtask result
- retry counters and action budgets
- pending human input, if any

### 6.4 Orchestrator Output Contract

The orchestrator returns one structured decision per evaluation.

Recommended shape:

```json
{
  "action": "run_script",
  "target_stage": "historical_search",
  "script_id": "repo.search",
  "input_patch": {
    "query": "find balanceOwner redemption implementations"
  },
  "state_patch": {
    "research_mode": "history_first"
  },
  "reason": "Need concrete repository evidence before running the stage role."
}
```

Allowed actions:

- `run_stage_agent`
- `run_script`
- `pause_for_input`
- `finish_run`
- `fail_run`

### 6.5 Stage Agent Contract

Each stage agent run:

- uses the stage role
- receives stage objective and resolved inputs
- may receive orchestrator-provided input patches
- returns outputs matching the stage declaration
- stores raw response as part of the run record

Recommended structured output shape:

```json
{
  "summary": "Mapped the relevant contracts and tests.",
  "outputs": {
    "codebase_context": {
      "artifact_label": "codebase_context",
      "content": "# Codebase Context\n..."
    }
  },
  "state_patch": {
    "contracts_identified": 4
  }
}
```

The worker is responsible for turning this into:

- stored raw logs
- registered artifacts
- normalized output fields
- optional mirrored files

### 6.6 Validation Rules

The worker or engine must reject:

- invalid JSON when JSON output is required
- missing required outputs
- outputs that do not match the declared stage contract
- attempts to write artifacts not declared or permitted by policy

### 6.7 Adapter Policy

The recipe should use stable conceptual config:

- backend
- model
- effort
- permissions
- timeout

The exact CLI flags for Claude, Codex, and Gemini belong to the adapter layer, not to the recipe DSL.

---

## 7. Script Registry and Execution Model

### 7.1 Script Registry

Every script callable by the orchestrator must be registered.

Recommended registry layout:

```yaml
scripts:
  - id: knowledge.prime
    description: Prime relevant knowledge sources and emit a consolidated context artifact.
    runtime: python
    path: scripts/knowledge/prime_knowledge.py
    timeout_ms: 300000
    retryable: true
    side_effects: read-only
    required_env:
      - ANTHROPIC_API_KEY

  - id: implementation.batch_bridge
    description: Convert Bees implementation tasks into Memory Bank task files and delegate to run_batch.py.
    runtime: python
    path: scripts/implementation/bees_batch_bridge.py
    timeout_ms: 3600000
    retryable: false
    side_effects: workspace-write

  - id: delivery.commit_and_pr
    description: Stage changes, commit, push branch, and draft a PR as bees-bot.
    runtime: python
    path: scripts/delivery/commit_and_pr.py
    timeout_ms: 180000
    retryable: false
    side_effects: workspace-write
```

### 7.2 Script Contract

Registered scripts use a normalized contract:

```text
STDIN   -> JSON payload
STDOUT  -> JSON result envelope
STDERR  -> progress stream for logs and Slack thread updates
EXIT 0  -> success
EXIT 1  -> failure
EXIT 2  -> needs human input / pause
```

Recommended stdout envelope:

```json
{
  "summary": "Delegated 6 implementation tasks to the existing pipeline.",
  "outputs": {
    "implementation_log": {
      "path": ".bees/implementation-log.md",
      "label": "implementation_log",
      "format": "md"
    }
  },
  "state_patch": {
    "mb_task_count": 6
  },
  "metrics": {
    "estimated_usd": 18.4
  }
}
```

### 7.3 Script Visibility To The Orchestrator

The orchestrator should know what scripts exist, but not by reading their raw source.

Its prompt context should include a **script catalog summary** containing:

- `script_id`
- description
- when to use it
- input contract summary
- output contract summary
- timeout
- retryability
- side effects

The worker may include:

- the full global summary
- the current stage allowlist
- or both

But the engine must always enforce the stage allowlist.

### 7.4 Env Interpolation

Recipes and script registry entries may reference environment variables using:

```text
{{env.VAR_NAME}}
```

Rules:

- interpolation must happen before spawn
- missing required env vars must fail clearly
- secrets must not be expanded into logs or echoed back into prompts

### 7.5 Script Safety Rules

- recipes reference scripts by ID, never by shell command
- mutating scripts must declare side effects
- the worker must enforce timeout and environment policy
- stderr streaming belongs to shared worker infrastructure, not script-specific Slack glue

---

## 8. Authoring Model

### 8.1 Repository Layout

Target layout:

```text
bees/
  recipes/
    new-implementation/
      recipe.yaml
    acp-consensus/
      recipe.yaml
    memory-bank/
      project-investigate/
        recipe.yaml
      td-planning/
        recipe.yaml
      dev-implement/
        recipe.yaml
    tbtc-monitor/
      recipe.yaml

  roles/
    orchestrators/
      implementation.md
      operations.md
      consensus.md
    implementation/
      planning-check.md
      planning-create.md
      historical-search.md
      planning-adjust.md
      codebase-map.md
      knowledge-synthesis.md
      guidelines.md
      task-breakdown.md
      implementation-coordinator.md
      delivery-coordinator.md
    memory-bank/
      project-investigator.md
      project-planner.md
      tdd-implementer.md
      qa-validator.md
    acp/
      proposer.md
      challenger.md
      synthesizer.md
    tbtc/
      monitor-operator.md

  scripts/
    registry.yaml
    knowledge/
      prime_knowledge.py
    implementation/
      bees_batch_bridge.py
      mb-batch-implement/
        run_batch.py
        parse_dag.py
        check_status.py
    delivery/
      commit_and_pr.py
    tbtc/
      wallet_status.py
      wallet_details.py
      dkg_status.py
      pending_actions.py
      lib/
        config.py
        onchain.py

  runtime/
    runs/
    artifacts/

  src/
    adapters/
    recipes/
    runtime/
    persistence/
    runners/
```

### 8.2 Author-Facing Rule

From an author's perspective, there are only three first-class authored assets:

- recipes
- roles
- scripts

Everything else is platform implementation.

### 8.3 Recipe Schema

Recommended author-facing schema:

```yaml
recipe:
  id: new-implementation
  name: New Implementation
  description: Full planning, implementation, and delivery workflow.
  version: 1

triggers:
  slack:
    command: /new-implementation
    argument_hint: "<description or planning file>"

inputs:
  required:
    request: Human request or problem statement.
  optional:
    planning_file_artifact: Existing planning artifact ID, if any.
    repo: Repository identifier, if not implied by channel.

orchestrator:
  role: roles/orchestrators/implementation.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  permissions: workspace-write
  timeout_ms: 180000
  max_stage_retries: 2
  max_total_actions: 40
  max_script_calls_per_stage: 3

stage_order:
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

start_stage: planning_check

stages:
  planning_check:
    role: roles/implementation/planning-check.md
    objective: Determine whether usable planning material already exists.
    inputs:
      request: "$inputs.request"
      planning_file_artifact: "$inputs.planning_file_artifact"
    outputs:
      plan_intake:
        format: md
        mirror_to:
          - .bees/plan-intake.md
    allowed_scripts: []
    allowed_transitions:
      - create_planning
      - planning_check

  historical_search:
    role: roles/implementation/historical-search.md
    objective: Find similar patterns and propose a grounded solution path.
    inputs:
      planning_doc: "$artifacts.planning_doc"
    outputs:
      solution_path:
        format: md
        mirror_to:
          - .bees/solution-path.md
      definition_of_done:
        format: md
        mirror_to:
          - .bees/definition-of-done.md
    allowed_scripts:
      - repo.search
      - repo.git_history
    allowed_transitions:
      - adjust_planning
      - create_planning
      - historical_search
    checkpoint:
      type: discuss_and_confirm
      timeout_hours: 4
```

### 8.4 Binding Syntax

Recipes should support simple bindings:

- `$inputs.<name>`
- `$state.<name>`
- `$task.<field>`
- `$artifacts.<label>`
- `$latest_subtask.<field>`

The worker resolves these before every subtask run.

### 8.5 Role File Convention

Roles are plain Markdown files.

Recommended structure:

```markdown
# Identity
Who this agent is and what it is responsible for.

# Working Style
How it should reason, inspect, validate, and communicate.

# Rules
Hard constraints it must obey.

# Output Expectations
What shape the output should take.
```

The prompt renderer places the resolved role content under the `# Role` section of the final CLI prompt.

### 8.6 Authoring Rules

1. One folder per recipe.
2. One `recipe.yaml` per recipe.
3. Every stage must declare a role.
4. Recipes do not embed raw script commands.
5. Scripts must be registered before a recipe can allow them.
6. Allowed transitions must be explicit.
7. Required checkpoints must be explicit.
8. All meaningful outputs must become artifacts.
9. If a file should remain human-convenient in the repo workspace, declare a mirror path.
10. Keep recipes declarative; move complexity into the orchestrator or scripts.

---

## 9. Primary Recipe: `/new-implementation`

### 9.1 Purpose

`/new-implementation` is the first full production recipe.

Its job is to take a request from Slack and drive it through:

- planning
- historical grounding
- context priming
- task synthesis
- external implementation execution
- commit and PR delivery

### 9.2 Input Contract

Minimum required input:

- freeform request text

Optional input:

- existing planning file or artifact ID
- target repo override
- priority
- linked issue, TIP, or PR context

### 9.3 Canonical Artifact Pack

The recipe should produce, at minimum:

- `planning_doc` -> `.bees/planning.md`
- `solution_path` -> `.bees/solution-path.md`
- `definition_of_done` -> `.bees/definition-of-done.md`
- `codebase_context` -> `.bees/codebase-context.md`
- `knowledge_context` -> `.bees/knowledge-context.md`
- `guidelines` -> `.bees/guidelines.md`
- `implementation_tasks` -> `.bees/implementation-tasks.md`
- `implementation_log` -> `.bees/implementation-log.md`
- `delivery_summary` -> `.bees/delivery-summary.md`

The `.bees/` copies are convenience mirrors. The authoritative record is the artifact registry.

### 9.4 Canonical Stage Graph

| Stage | Purpose | Primary Outputs | Allowed Scripts | Checkpoint |
| --- | --- | --- | --- | --- |
| `planning_check` | Determine whether a usable plan already exists | `plan_intake` | none | no |
| `create_planning` | Create or normalize planning | `planning_doc` | none | may pause for missing info |
| `historical_search` | Search repo and history, propose solution path | `solution_path`, `definition_of_done` | `repo.search`, `repo.git_history` | yes |
| `adjust_planning` | Update plan after feedback | `planning_doc` | none | no |
| `prime_codebase` | Map relevant code structure | `codebase_context` | `repo.search`, `repo.file_map` | no |
| `prime_knowledge` | Build knowledge context | `knowledge_context` | `knowledge.prime` | no |
| `prime_guidelines` | Build coding/testing guidelines | `guidelines` | none | no |
| `create_tasks` | Produce atomic implementation tasks | `implementation_tasks` | none | yes |
| `batch_implement` | Execute implementation through bridge | `implementation_log` | `implementation.batch_bridge` | no |
| `commit_and_pr` | Commit, push, and draft PR | `delivery_summary`, `pr_url` | `delivery.commit_and_pr` | no |

### 9.5 Stage Details

#### Stage 1: `planning_check`

**Role:** `roles/implementation/planning-check.md`

**Objective:**

- detect whether the request already includes usable planning material
- identify whether the material is complete, partial, or missing

**Inputs:**

- request text
- attachments
- optional planning artifact reference

**Outputs:**

- `plan_intake`
- `has_existing_plan` flag

**Allowed transitions:**

- `create_planning`
- `planning_check` (self retry if parsing failed)

#### Stage 2: `create_planning`

**Role:** `roles/implementation/planning-create.md`

**Objective:**

- create a planning doc from scratch, or
- normalize an existing plan into the Bees format

**Outputs:**

- `planning_doc`

**Pause rule:**

If critical information is missing, the orchestrator may pause for input before allowing this stage to finish.

**Canonical mirror:** `.bees/planning.md`

**Allowed transitions:**

- `historical_search`
- `create_planning`

#### Stage 3: `historical_search`

**Role:** `roles/implementation/historical-search.md`

**Objective:**

- find similar implementations in repo history
- identify patterns to copy or avoid
- propose a grounded solution path
- produce a concrete definition of done

**Typical orchestrator behavior in this stage:**

- queue one or more registered repo search scripts if useful
- queue the stage agent once enough evidence exists

**Outputs:**

- `solution_path`
- `definition_of_done`

**Checkpoint:**

- type: `discuss_and_confirm`
- required before leaving the stage

**Allowed transitions:**

- `adjust_planning`
- `create_planning`
- `historical_search`

#### Stage 4: `adjust_planning`

**Role:** `roles/implementation/planning-adjust.md`

**Objective:**

- revise the plan using historical findings and user feedback
- mark the plan as approved

**Outputs:**

- updated `planning_doc`

**Allowed transitions:**

- `prime_codebase`
- `historical_search`

#### Stage 5: `prime_codebase`

**Role:** `roles/implementation/codebase-map.md`

**Objective:**

- map relevant contracts, files, tests, and dependencies
- identify constraints and affected areas

**Outputs:**

- `codebase_context`

**Allowed scripts:**

- `repo.search`
- `repo.file_map`

**Allowed transitions:**

- `prime_knowledge`
- `adjust_planning`
- `prime_codebase`

#### Stage 6: `prime_knowledge`

**Role:** `roles/implementation/knowledge-synthesis.md`

**Objective:**

- assemble the knowledge context needed for implementation

**Important note:**

This stage is still agent-oriented in the recipe, but it is expected to be script-assisted. The orchestrator may queue `knowledge.prime`, inspect the results, and then queue the stage agent to synthesize or validate the final `knowledge_context`.

**Outputs:**

- `knowledge_context`

**Allowed scripts:**

- `knowledge.prime`

**Allowed transitions:**

- `prime_guidelines`
- `prime_codebase`
- `prime_knowledge`

#### Stage 7: `prime_guidelines`

**Role:** `roles/implementation/guidelines.md`

**Objective:**

- compile coding, testing, and delivery guidelines relevant to this implementation

**Outputs:**

- `guidelines`

**Allowed transitions:**

- `create_tasks`
- `prime_codebase`
- `prime_knowledge`

#### Stage 8: `create_tasks`

**Role:** `roles/implementation/task-breakdown.md`

**Objective:**

- convert the approved plan into atomic implementation tasks
- make them small, testable, and ordered

**Outputs:**

- `implementation_tasks`

**Checkpoint:**

- type: `approve_or_adjust`
- required before leaving the stage

**Allowed transitions:**

- `batch_implement`
- `adjust_planning`
- `create_tasks`

#### Stage 9: `batch_implement`

**Role:** `roles/implementation/implementation-coordinator.md`

**Objective:**

- execute implementation through the existing Memory Bank TDD pipeline
- inspect whether implementation completed successfully
- decide whether re-planning or task adjustments are needed

**Important note:**

This stage is also agent-oriented in the recipe. The orchestrator may:

1. queue `implementation.batch_bridge`
2. inspect its output
3. queue the stage agent to summarize or interpret the result
4. either continue to delivery or revisit an earlier stage

**Outputs:**

- `implementation_log`
- `implementation_summary`

**Allowed scripts:**

- `implementation.batch_bridge`

**Allowed transitions:**

- `commit_and_pr`
- `create_tasks`
- `adjust_planning`
- `batch_implement`

#### Stage 10: `commit_and_pr`

**Role:** `roles/implementation/delivery-coordinator.md`

**Objective:**

- verify the implementation state is ready to ship
- commit changes as `bees-bot`
- push the feature branch
- open a draft PR

**Outputs:**

- `delivery_summary`
- `pr_url`

**Allowed scripts:**

- `delivery.commit_and_pr`

**Allowed transitions:**

- `commit_and_pr`
- `batch_implement`

### 9.6 Planning Document Format

The canonical planning format remains:

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
- [ ] Criterion 1
- [ ] Criterion 2

## Technical Approach
High-level description of the approach.

## Files Affected (estimated)
- `src/...` - reason
- `test/...` - reason

## Risks & Unknowns
- Risk 1 - mitigation
- Unknown 1 - how to resolve

## Definition of Done
- [ ] All acceptance criteria met
- [ ] Build passes
- [ ] Tests pass
- [ ] PR drafted
```

### 9.7 Implementation Tasks Format

`implementation_tasks` should be easy to convert into downstream task systems.

Recommended structure:

```markdown
# Implementation Tasks

## Task 1: [Short title]

### Goal
...

### Acceptance Criteria
- [ ] ...

### Estimated Files
- `src/...`
- `test/...`

### Dependencies
- None

## Task 2: [Short title]
...
```

### 9.8 Recipe Excerpt

```yaml
recipe:
  id: new-implementation
  name: New Implementation
  description: Plan, implement, and deliver a feature request.

triggers:
  slack:
    command: /new-implementation

orchestrator:
  role: roles/orchestrators/implementation.md
  backend: cli-claude
  model: anthropic/claude-sonnet-4-20250514
  effort: high
  max_stage_retries: 2
  max_total_actions: 40
  max_script_calls_per_stage: 3

stage_order:
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
```

---

## 10. Existing Pipeline Integration

### 10.1 What Already Exists

The existing implementation pipeline already solves a real problem and should be reused, not replaced immediately.

Current proven pieces:

- `run_batch.py` dependency-aware batch executor
- `mb-dev-implement` multi-agent TDD flow
- task file format (`T-XXX.md`)
- resume support via task status
- structured artifact files

### 10.2 Initial Integration Strategy

Bees should wrap the existing system through registered scripts.

Initial scripts:

- `knowledge.prime`
- `implementation.batch_bridge`
- `delivery.commit_and_pr`

This keeps the Bees runtime focused on:

- orchestration
- task/subtask control
- journaling
- artifacts
- Slack integration

### 10.3 `implementation.batch_bridge`

`implementation.batch_bridge` is the bridge between:

- Bees artifacts and state
- Memory Bank task files and `run_batch.py`

Responsibilities:

1. Read Bees planning and context artifacts.
2. Convert `implementation_tasks` into downstream task files.
3. Prepare the Memory Bank task directory structure.
4. Delegate to `run_batch.py`.
5. Stream progress over stderr.
6. Collect downstream results.
7. Emit `implementation_log` back to Bees.

### 10.4 Registered Bridge Contract

Input should include:

- task metadata
- workspace path
- branch metadata
- planning artifact ID
- codebase context artifact ID
- knowledge context artifact ID
- guidelines artifact ID
- implementation tasks artifact ID

Output should include:

- `implementation_log`
- status summary
- task count
- estimated cost when available

### 10.5 Migration Path

**Path A: wrap existing pipeline now**

- use the bridge
- leave downstream agents unchanged

**Path B: instrument more deeply later**

- capture richer per-phase progress
- expose downstream cost and artifact metadata more cleanly

**Path C: migrate workflow families into native recipes over time**

- Memory Bank becomes a recipe pack
- ACP becomes a recipe
- script-heavy workflows remain script-assisted recipes

---

## 11. Delivery and GitHub Model

### 11.1 Machine User

Bees should operate under a dedicated GitHub machine user.

Recommended:

| Field | Value |
| --- | --- |
| Account | `bees-bot` or `t-labs-bees` |
| Email | `bees@t-labs.dev` |
| Org access | write access to target repos |
| Auth | fine-grained PAT to start |
| Future | migrate to GitHub App when worthwhile |

### 11.2 Workspace Git Identity

Each task workspace should set:

```bash
git config user.name "bees-bot"
git config user.email "bees@t-labs.dev"
```

This must be local to the task workspace, not global to the host.

### 11.3 Requester Identity Mapping

Bees needs a `BeesUser` mapping from Slack identity to GitHub identity.

Recommended fields:

```typescript
interface BeesUser {
  slackUserId: string;
  slackDisplayName: string;
  githubLogin?: string;
  githubName?: string;
  githubEmail?: string;
}
```

This mapping is used for:

- `Requested-by` trailers
- `Co-authored-by` trailers
- PR body attribution

### 11.4 Commit Attribution

Commits should look like:

```text
feat(staking): add rewards calculation

Implements staking rewards calculation per TIP-112.

Requested-by: @leonardo via Bees
Co-authored-by: Leonardo <leonardo@tnetworklabs.com>
```

Meaning:

- committer: `bees-bot`
- requester: human who initiated the task

### 11.5 Branch Naming

Recommended branch format:

```text
bees/<task-id>-<slugified-title>
```

Example:

```text
bees/task-0042-balanceowner-redemption-fix
```

The branch name must be passed into downstream scripts so the whole chain agrees on one branch.

### 11.6 PR Creation

Delivery should happen through a registered script, initially `delivery.commit_and_pr`.

The PR body should include:

- recipe used
- requester identity
- summary of changes
- acceptance criteria checklist
- test results
- cost summary when available
- link to Slack thread

### 11.7 Token Rotation

Options:

- start with a PAT and calendar reminder
- later move to a GitHub App with short-lived installation tokens

Recommendation:

- PAT first
- GitHub App later when the platform stabilizes

---

## 12. Slack, Human Interaction, and Cron

### 12.1 Slack Recipe Triggers

High-frequency recipes may get dedicated slash commands:

```text
/new-implementation <request>
/acp-consensus <prompt>
/mb-project-investigate <request>
/tbtc-monitor <query>
```

Later, a generic fallback can exist:

```text
@bees run <recipe-id> <payload>
```

But the initial UX should prioritize direct commands for important workflows.

### 12.2 Management Commands

Recommended command set:

```text
@bees status
@bees status <task-id>
@bees queue
@bees continue
@bees approve
@bees retry
@bees pause
@bees cancel <task-id>
@bees priority <task-id> <level>
@bees cost
@bees cron <subcommand>
@bees help
```

### 12.3 Human Interaction Model

Human interaction is first-class.

Canonical flow:

1. The orchestrator decides `pause_for_input`.
2. The active subtask enters `needs_input`.
3. The task enters `paused`.
4. Bees posts the required question or approval request in the task thread.
5. The user replies in thread.
6. A `resume_after_input` subtask is queued.
7. The worker captures that input and re-queues `orchestrator_eval`.

### 12.4 Checkpoints

Checkpoints are recipe-defined, not improvised.

For `/new-implementation`, required checkpoints are:

- after `historical_search`
- after `create_tasks`

### 12.5 Timeout Behavior

If there is no response within the timeout window:

- the task moves from `paused` to `waiting`
- the queue is unblocked
- the task can be resumed later without losing its context

### 12.6 Notification Flow

Each task gets one canonical Slack thread.

Illustrative flow:

```text
#bees-tasks

New task: "Implement balanceOwner redemption fix"
Recipe: /new-implementation | Priority: normal | Position: #1
|
|- Task started
|- Subtask: orchestrator_eval -> current stage planning_check
|- Subtask: stage_agent_run(planning_check) -> completed
|- Subtask: orchestrator_eval -> queue create_planning
|- Subtask: stage_agent_run(create_planning) -> completed
|- Subtask: orchestrator_eval -> queue historical_search
|- Subtask: script_run(repo.search) -> completed
|- Subtask: stage_agent_run(historical_search) -> completed
|- Checkpoint required: discuss and confirm solution path
|- User replied: "Use the pattern from PR #482"
|- resume_after_input -> orchestrator_eval
|- ...
|- Subtask: script_run(knowledge.prime) -> completed
|- Subtask: stage_agent_run(prime_knowledge) -> completed
|- ...
|- Subtask: script_run(implementation.batch_bridge) -> progress streaming...
|- ...
|- Subtask: script_run(delivery.commit_and_pr) -> completed
|- Task completed: PR #512 drafted
```

### 12.7 Cron Jobs

Cron should reference recipes, not legacy gates.

```typescript
interface CronJob {
  id: string;
  name: string;
  schedule: string;
  recipeId: string;
  payload: Record<string, unknown>;
  priority: "normal" | "high";
  enabled: boolean;
  createdBy: string;
  lastRun?: Date;
  nextRun?: Date;
}
```

Example commands:

```text
@bees cron add "0 9 * * MON" /mb-project-investigate "scan staking module"
@bees cron add "0 6 * * *" /tbtc-monitor "pending-actions"
@bees cron list
@bees cron delete <id>
@bees cron pause <id>
@bees cron resume <id>
```

---

## 13. Technology Stack and Project Structure

### 13.1 Technology Stack

| Component | Technology | Why |
| --- | --- | --- |
| Runtime | Node.js 22+ + TypeScript | stable ESM, TS-first runtime |
| Agent execution | one-shot CLI worker adapters | model-agnostic Claude/Codex/Gemini support |
| Agent CLIs | `claude`, `codex`, `gemini` | pre-installed host tools |
| Task queue | BullMQ + Redis | ordered queueing and cron support |
| Persistence | SQLite (`better-sqlite3`) | tasks, subtasks, journal, users, cron metadata |
| Slack | `@slack/bolt` | mature Slack integration |
| Recipe format | YAML | version-controlled and author-friendly |
| Role format | Markdown | easy to review and edit |
| Script runtime | Python 3.12+ and shell where appropriate | existing ecosystem compatibility |
| GitHub integration | `gh` or GitHub API | PR creation and metadata |
| Process manager | PM2 or systemd | service stability |

### 13.2 Target Project Structure

```text
bees/
├── package.json
├── tsconfig.json
├── .env
├── docker-compose.yml
│
├── recipes/
│   ├── new-implementation/
│   │   └── recipe.yaml
│   ├── acp-consensus/
│   │   └── recipe.yaml
│   ├── memory-bank/
│   │   ├── project-investigate/
│   │   │   └── recipe.yaml
│   │   ├── td-planning/
│   │   │   └── recipe.yaml
│   │   └── dev-implement/
│   │       └── recipe.yaml
│   └── tbtc-monitor/
│       └── recipe.yaml
│
├── roles/
│   ├── orchestrators/
│   ├── implementation/
│   ├── memory-bank/
│   ├── acp/
│   └── tbtc/
│
├── scripts/
│   ├── registry.yaml
│   ├── knowledge/
│   ├── implementation/
│   ├── delivery/
│   ├── memory-bank/
│   └── tbtc/
│
├── runtime/
│   ├── runs/
│   └── artifacts/
│
├── src/
│   ├── index.ts
│   ├── adapters/
│   ├── recipes/
│   │   ├── loader.ts
│   │   ├── validator.ts
│   │   └── router.ts
│   ├── runtime/
│   │   ├── queue/
│   │   ├── orchestrator/
│   │   ├── worker/
│   │   ├── journal/
│   │   ├── artifacts/
│   │   ├── state/
│   │   └── scripts/
│   ├── runners/
│   │   ├── cli-claude.ts
│   │   ├── cli-codex.ts
│   │   ├── cli-gemini.ts
│   │   └── prompt-renderer.ts
│   ├── persistence/
│   └── utils/
│
└── tests/
```

### 13.3 Migration Note

During migration, some existing directories may temporarily remain:

- `gates/`
- `skills/`
- direct executor modules

Those are compatibility shims, not the target long-term authoring model.

---

## 14. Delivery Phases

### Phase 1: Skeleton and Walking Skeleton

Outcome:

- Slack input works
- one task can be queued and executed
- one trivial workflow can complete end to end

### Phase 2A: Current Implemented Planning Baseline

Outcome:

- `/new-implementation` planning flow runs linearly
- `.bees/` planning artifacts exist
- current behavior becomes the compatibility baseline

### Phase 2B: Orchestrator Runtime and Deterministic Worker

Outcome:

- recipe stage-graph model
- task/subtask queue model
- orchestrator decisions
- deterministic worker
- pause/resume and minimal durable recovery

### Phase 2C: Script Registry and Bridge Integrations

Outcome:

- registered scripts become first-class runtime capabilities
- `script_run` path is fully implemented
- `knowledge.prime` and `implementation.batch_bridge` are integrated

### Phase 2D: Delivery Scripts and Mutating Workflow Safety

Outcome:

- deterministic delivery scripts exist
- branch, commit, push, and PR flows are safe and recoverable

### Phase 2E: Orchestrator, Role, and Script Hardening

Outcome:

- orchestrator behavior is hardened
- role packs are real and reusable
- script packs are validated on real runs
- first supervised live implementation run succeeds

### Phase 3: Operations, Recovery, and Governance

Outcome:

- operators can inspect tasks, subtasks, artifacts, and journal history
- cron is durable
- cost and failure handling are credible

### Phase 4: Team Rollout and Authoring Enablement

Outcome:

- teams can use Bees safely
- recipe, role, and script authoring is documented and supported

### Phase 5: Recipe Packs and Workflow Migrations

Outcome:

- Memory Bank workflows migrate in
- ACP migrates in
- operational packs migrate in

### Phase 6: Channel and Adapter Expansion

Outcome:

- channels beyond Slack become viable
- task/subtask execution remains channel-agnostic

### Phase 7: Advanced Agent Execution and Policy

Outcome:

- richer execution modes exist without changing the author-facing recipe model

### Phase 8: Visibility and Self-Hosted Expansion

Outcome:

- dashboards and self-hosted execution become realistic follow-ons

---

## 15. Open Decisions

| # | Question | Options | Recommendation | Status |
| --- | --- | --- | --- | --- |
| 1 | Generic trigger model | dedicated slash commands vs. generic `@bees run` | start with dedicated commands for important recipes, add generic later | Open |
| 2 | Script registry source of truth | YAML manifest vs. TS registration | YAML manifest for authoring clarity, optional generated TS cache later | Open |
| 3 | Active-task concurrency | one task vs. several parallel tasks | keep one active task initially | Open |
| 4 | Artifact retention policy | keep forever vs. prune old artifacts | keep all during early rollout, add retention later | Open |
| 5 | Workspace isolation | worktree vs. full clone | worktree per task when possible | Open |
| 6 | Cost enforcement | observe only vs. hard budget gates | observe first, enforce later | Open |
| 7 | GitHub auth | PAT vs. GitHub App | PAT first, GitHub App later | Open |
| 8 | Active subtask recovery on restart | restart from scratch vs. resume safely | paused/waiting must resume safely first; active re-entry rules can follow | Open |
| 9 | Orchestrator scope | fully unconstrained vs. recipe-bounded | recipe-bounded orchestration | Resolved |
| 10 | Author-facing workflow model | gates/skills/tools vs. recipes/roles/scripts | recipes + roles + registered scripts | Resolved |
| 11 | Prompt contract | provider-specific prompt assembly vs. common role/task/output contract | common `# Role` / `# Task` / `# Output` contract | Resolved |
| 12 | Script visibility | raw shell commands vs. registered catalog | registered catalog with metadata summary | Resolved |

---

## 16. Final Working Rules

These rules should remain true unless a later scope revision changes them explicitly:

1. Recipes define workflow topology.
2. Roles define behavior.
3. Scripts define deterministic capabilities.
4. The orchestrator decides what subtask is queued next.
5. The worker executes subtasks and does not decide direction.
6. All scripts callable by the orchestrator must be registered.
7. All meaningful outputs become artifacts with durable IDs.
8. The run journal is append-only.
9. `/new-implementation` is the first production recipe, not the only recipe model.
10. The platform must feel simple to author even if the runtime is internally sophisticated.
