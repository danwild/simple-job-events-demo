# IVCAP Job Events Demo Client

A React web client for visualizing and interacting with IVCAP Job Events. The client provides two routes:

- **`/`** -- Workflow simulation demo with real-time event streaming.
- **`/chat`** -- ChatGPT-style chat UI where every message is routed through an IVCAP job, and LLM tokens stream back via Job Events.

## Tech Stack

- **React 19** -- UI framework
- **Vite** -- Build tool and dev server
- **TypeScript** -- Type safety
- **Tailwind CSS v4** -- Utility-first styling
- **shadcn/ui** -- Component library (Badge, Button, Card)
- **Vercel AI SDK v6** -- Chat UI message state primitives (`useChat`, `UIMessage`)

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm
- A deployed Workflow Simulator service on IVCAP (you need its service URN)

This UI is written against the **IVCAP Jobs API** (create job, poll status, fetch job events). It does not call the local tool endpoint (`POST /`) directly.

### Start the Client

```bash
cd client

# Install dependencies
pnpm install

# Start dev server
pnpm dev
```

The app will be available at `http://localhost:5173`.

- Workflow demo: `http://localhost:5173/`
- Chat demo: `http://localhost:5173/chat`

### Build for Production

```bash
pnpm build
pnpm preview
```

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```bash
# IVCAP API base URL (default is develop)
VITE_API_URL=https://develop.ivcap.net

# Workflow Simulator service URN (required to target your deployed service)
VITE_SERVICE_URN=urn:ivcap:service:...

# Required for non-public IVCAP endpoints
VITE_AUTH_TOKEN=your-bearer-token-here

# Optional for demo docs/reference.
# Backend uses LITELLM_PROXY and IVCAP_JWT for actual proxy calls.
VITE_LITELLM_PROXY=https://mindweaver.develop.ivcap.io/litellm
```

## Project Structure

```
client/
├── src/
│   ├── components/
│   │   ├── ui/              # shadcn/ui components (badge, button, card)
│   │   └── EventStream.tsx  # Event display component with auto-scroll
│   ├── hooks/
│   │   ├── useWorkflow.ts        # Workflow execution lifecycle
│   │   └── useChatJobEvents.ts   # Chat state: job creation, SSE events, token streaming
│   ├── lib/
│   │   ├── api.ts           # IVCAP API client (job create, status poll, SSE events)
│   │   └── utils.ts         # Utility functions (cn helper)
│   ├── types/
│   │   └── events.ts        # TypeScript type definitions (JobEvent, ChatMessage, etc.)
│   ├── pages/
│   │   └── ChatPage.tsx     # ChatGPT-style chat UI
│   ├── App.tsx              # Route definitions (/, /chat)
│   ├── main.tsx             # Entry point
│   └── index.css            # Global styles + Tailwind
├── components.json          # shadcn/ui configuration
├── vite.config.ts           # Vite configuration with proxy
└── package.json
```

## Features

### Chat Route (`/chat`)

A ChatGPT-style conversational interface for testing chat latency and UX through the IVCAP Job Events pipeline.

**How it works:**

1. User types a message (or clicks an example prompt button).
2. The client creates an IVCAP chat job via `POST /1/services2/{service_urn}/jobs`.
3. The client polls for job status until the job enters `running`/`executing`.
4. Once running, the client subscribes to the job's SSE event stream.
5. Non-token lifecycle events (`chat:request`, `chat:response`) are displayed as status messages in the assistant bubble.
6. Batched token events (`chat:tokens:*`) are extracted and fed into a **typewriter animation** that reveals text character-by-character (~40 chars/sec), producing a smooth streaming effect even though tokens arrive in batches. Legacy singular `chat:token:*` events are also supported.
7. On completion, any remaining queued typewriter text is flushed instantly, and timing metrics are displayed.

**UI features:**

- **Full-height chat layout** -- Scrollable messages area with bottom-pinned input bar.
- **Chat bubbles** -- User messages right-aligned (primary color), assistant messages left-aligned (muted background).
- **Thinking indicator** -- Animated bouncing dots with real-time status messages from the backend (e.g., "Submitting chat request to model 'gpt-5-mini'", "Streaming model response").
- **Typewriter animation** -- Batched tokens are revealed character-by-character (~25 ms/char) for a smooth streaming illusion; remaining text is flushed instantly on completion.
- **Streaming cursor** -- Blinking cursor at the end of the assistant text while tokens are arriving.
- **Example prompts** -- Pre-built prompt buttons on the empty state for one-click testing ("AI Agent Architectures", "RAG vs Fine-tuning", "Quick test").
- **Timing metrics bar** -- Compact row above the input showing latency deltas: Submit-to-Executing, Submit-to-First-Event, Submit-to-First-Token, Submit-to-Complete.
- **Collapsible debug panel** -- Right-side panel (toggle via "Debug" button) showing job diagnostics (status, job ID, token event count, connection status) and a raw event stream.
- **Keyboard shortcuts** -- Enter to send, Shift+Enter for newline.
- **Retry resilience** -- SSE long-poll automatically retries on transient network errors (HTTP/2 resets, timeouts) with exponential backoff up to 5 consecutive failures.

**Event flow:**

```
User message
  → POST /1/services2/{urn}/jobs (create chat job)
  → IVCAP schedules job → tool-service.py /chat endpoint
  → chat_simulator.py streams LLM via LiteLLM proxy
  → Tokens batched and emitted as chat:tokens:{n} Job Events
  → GET .../jobs/{id}/events (SSE long-poll)
  → Client typewriter animation reveals text char-by-char
```

### Workflow Demo Route (`/`)

- Select from available presets: `simple_pipeline`, `deep_research`, `multi_agent_crew`, `timer_tick`
- Start/stop workflow execution
- Real-time event stream with color-coded event types
- Timing summary: submit-to-executing, submit-to-first-event, submit-to-exit

### Event Stream Component

Shared across both routes:

- Live event display with auto-scroll
- Color-coded by event type (workflow, phase, agent, task)
- Timestamps, status indicators, and connection status badge

## Key Hooks

### `useChatJobEvents`

Manages the full chat lifecycle. Returns:

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `UIMessage[]` | Full conversation transcript (AI SDK format) |
| `submitPrompt` | `(prompt: string) => Promise<void>` | Send a user message and start a chat job |
| `reset` | `() => void` | Clear conversation and abort any active job |
| `isBusy` | `boolean` | True while submitting or streaming |
| `isStreaming` | `boolean` | True once tokens are actively arriving |
| `status` | `ChatRunStatus` | `'idle' \| 'submitting' \| 'streaming' \| 'success' \| 'error'` |
| `statusMessage` | `string \| null` | Latest non-token lifecycle event message |
| `jobId` | `string \| null` | Current IVCAP job ID |
| `error` | `string \| null` | Error message if any |
| `tokenEvents` | `number` | Count of token events received |
| `events` | `JobEvent[]` | All raw events (for debug panel) |
| `submittedAt` | `Date \| null` | When the user hit send |
| `executingAt` | `Date \| null` | When the job started executing |
| `firstEventAt` | `Date \| null` | When the first SSE event arrived |
| `firstTokenAt` | `Date \| null` | When the first token was received |
| `finishedAt` | `Date \| null` | When the job reached a terminal state |

### `useWorkflow`

Manages workflow simulation lifecycle (preset selection, job creation, event subscription, status polling).

## Development

### Adding Components

Use the shadcn CLI to add more UI components:

```bash
pnpm dlx shadcn@latest add [component-name]
```

Browse available components at [ui.shadcn.com](https://ui.shadcn.com/docs/components).

### Architecture

```
┌───────────────────────┐    Jobs API (HTTP)     ┌──────────────────────────┐
│  React Client         │ ────────────────────▶  │  IVCAP Platform API       │
│                       │                        │  (/1/services2/...)       │
│  useChatJobEvents     │ ◀────────────────────  │  - creates job            │
│  useWorkflow          │    status poll + SSE    │  - exposes job-events     │
│                       │    event stream         └───────────┬──────────────┘
│  ChatPage  (tokens)   │                                     │
│  WorkflowDemo (steps) │                                     │ runs
└───────────────────────┘                                     ▼
                                               ┌──────────────────────────┐
                                               │ Workflow Simulator Tool   │
                                               │ (your deployed service)   │
                                               │                          │
                                               │ POST /     → workflow    │
                                               │ POST /chat → LLM stream │
                                               └──────────────────────────┘
```

The client creates and monitors jobs via the IVCAP Jobs API:

- `POST /1/services2/{service_urn}/jobs` -- Create a job (workflow or chat)
- `GET /1/services2/{service_urn}/jobs/{job_id}` -- Poll job status (every 2s)
- `GET /1/services2/{service_urn}/jobs/{job_id}/events` -- SSE long-poll for job events

> **Auth note:** `VITE_AUTH_TOKEN` is used for client-to-IVCAP Jobs API calls. LiteLLM proxy authentication is handled by the backend via job authorization (deployed) or `IVCAP_JWT` (local runs).
