# Workflow Simulator - IVCAP Job Events Demo

This project simulates multi-agent workflows (like CrewAI or ChatGPT Deep Research) by emitting realistic IVCAP Job Events. It is designed to help develop and test frontend UX patterns against realistic event streams.

> **Optional UI:** There is a small React client in `client/` which can create a job via the IVCAP Jobs API and (best-effort) fetch the job's events for display.

## Inputs

- **preset_name** (required): Name of the workflow preset to run
  - `deep_research` - Multi-phase research workflow (Planning → Search → Analysis → Synthesis → Review)
  - `multi_agent_crew` - CrewAI-style with specialized agent roles
  - `simple_pipeline` - Basic 3-step sequential workflow for quick testing
- **timing_multiplier** (optional, default: 1.0): Scale factor for delays
  - `0.5` = 2x faster (good for testing)
  - `2.0` = 2x slower (more realistic feel)

## Outputs

- **message**: Success message on workflow completion
- **preset_name**: Name of the preset that was executed
- **phases_completed**: Number of phases completed
- **agents_executed**: Number of agents that executed
- **total_events**: Total number of events emitted
- **elapsed_seconds**: Total execution time in seconds

## Event Structure

Events are emitted hierarchically:
- `workflow:{name}` - Overall workflow start/complete
- `phase:{phase_id}` - Phase start/complete (e.g., `phase:research`)
- `agent:{phase_id}:{agent_id}` - Agent start/complete (e.g., `agent:research:web_searcher`)
- `agent:{phase_id}:{agent_id}:task-{n}` - Individual task updates

## Example: `deep_research` workflow (Mermaid)

The simulator emits **started** and **finished** events for each `step_id` below (via `JobContext.report.step_started(...)` / `step_finished(...)`).

```mermaid
flowchart TB
  W["workflow:deep_research<br/>started → finished"]

  %% Phases (from presets/deep_research.json)
  W --> PPlanning["phase:planning (Research Planning)<br/>started → finished"]
  W --> PSearch["phase:search (Information Gathering)<br/>started → finished"]
  W --> PAnalysis["phase:analysis (Deep Analysis)<br/>started → finished"]
  W --> PSynthesis["phase:synthesis (Report Synthesis)<br/>started → finished"]
  W --> PReview["phase:review (Quality Review)<br/>started → finished"]

  %% Planning agents
  PPlanning --> AQuery["agent:planning:query_analyzer<br/>started → finished"]
  PPlanning --> AScope["agent:planning:scope_planner<br/>started → finished"]

  %% Search agents
  PSearch --> AWeb["agent:search:web_searcher<br/>started → finished"]
  PSearch --> AFetch["agent:search:content_fetcher<br/>started → finished"]

  %% Analysis agents
  PAnalysis --> AFact["agent:analysis:fact_extractor<br/>started → finished"]
  PAnalysis --> AContra["agent:analysis:contradiction_detector<br/>started → finished"]
  PAnalysis --> AInsight["agent:analysis:insight_generator<br/>started → finished"]

  %% Synthesis agents
  PSynthesis --> AOutline["agent:synthesis:outline_builder<br/>started → finished"]
  PSynthesis --> AWrite["agent:synthesis:content_writer<br/>started → finished"]
  PSynthesis --> ACite["agent:synthesis:citation_manager<br/>started → finished"]

  %% Review agents
  PReview --> ACheck["agent:review:fact_checker<br/>started → finished"]
  PReview --> AEdit["agent:review:editor<br/>started → finished"]

  %% Task events (example: one agent emits task-1..task-n, each started → finished)
  AWeb --> T1["agent:search:web_searcher:task-1<br/>started → finished"]
  AWeb --> T2["agent:search:web_searcher:task-2<br/>started → finished"]
  AWeb --> T3["agent:search:web_searcher:task-…<br/>started → finished"]
```

## Expected Behaviour

1. The service loads the specified preset from `presets/{preset_name}.json`
2. For each **phase** in the workflow:
   - Emit `phase:{id}:started` event
   - Wait a random delay within the phase's `delay_range_ms`
   - Execute all **agents** in the phase:
     - Emit `agent:{phase}:{agent}:started` event
     - For each **task**, emit task status events with random delays
     - Emit `agent:{phase}:{agent}:completed` event
   - Emit `phase:{id}:completed` event
3. Return summary statistics on workflow completion

## Adding Custom Presets

Create a new JSON file in `presets/` following this schema:

```json
{
  "name": "my_workflow",
  "description": "Description of the workflow",
  "phases": [
    {
      "id": "phase_id",
      "name": "Phase Display Name",
      "delay_range_ms": [500, 2000],
      "agents": [
        {
          "id": "agent_id",
          "name": "Agent Display Name",
          "tasks": ["Task 1 message...", "Task 2 message..."],
          "delay_range_ms": [1000, 3000]
        }
      ]
    }
  ]
}
```

## Optional: Web Client (`client/`)

The `client/` folder contains a small React/Vite UI used to demo the workflow simulator via the **IVCAP Jobs API**:

- Creates a job: `POST /1/services2/{service_urn}/jobs`
- Polls job status: `GET /1/services2/{service_urn}/jobs/{job_id}`
- Fetches job events (best-effort): `GET /1/services2/{service_urn}/jobs/{job_id}/events`

### Prerequisites

- Node.js 20+
- `pnpm`
- A deployed Workflow Simulator service on IVCAP (you need its **service URN**)
- An IVCAP access token (Bearer token) if required by your environment

### Run the client

From the repo root:

```bash
cd client
pnpm install

# Configure env (see Configuration below), then:
pnpm dev
```

### Configuration

The UI is configured via Vite env vars:

- `VITE_API_URL`: IVCAP base URL (defaults to `https://develop.ivcap.net`)
- `VITE_SERVICE_URN`: Workflow Simulator service URN (defaults to a demo URN in code)
- `VITE_AUTH_TOKEN`: Bearer token (optional in code, but typically required for non-public IVCAP endpoints)

### Note about local runs

Running the tool locally (e.g. `poetry ivcap run -- --port 8078`) is great for validating the simulator logic and response payload, but the `client/` UI is currently written against the **IVCAP platform Jobs API** (not the local `POST /` tool endpoint), so it will not display local job events unless you provide an IVCAP-compatible Jobs API in front of it.
