# IVCAP Job Events Demo Client

A React web client for visualizing and interacting with IVCAP Job Events.

## Tech Stack

- **React 19** - UI framework
- **Vite** - Build tool and dev server
- **TypeScript** - Type safety
- **Tailwind CSS v4** - Utility-first styling
- **shadcn/ui** - Component library
- **Vercel AI SDK v6** - Chat UI message state primitives

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

The app will be available at `http://localhost:5173`

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

# Optional in code, but typically required for non-public IVCAP endpoints
VITE_AUTH_TOKEN=your-bearer-token-here

# Optional for demo docs/reference.
# Backend uses LITELLM_PROXY and LITELLM_API_KEY for actual proxy calls.
VITE_LITELLM_PROXY=https://mindweaver.develop.ivcap.io/litellm
```

## Project Structure

```
client/
├── src/
│   ├── components/
│   │   ├── ui/              # shadcn/ui components
│   │   └── EventStream.tsx  # Event display component
│   ├── hooks/
│   │   ├── useWorkflow.ts        # Workflow state management
│   │   └── useChatJobEvents.ts   # AI SDK state + JobEvents adapter
│   ├── lib/
│   │   ├── api.ts           # API client (job create, events)
│   │   └── utils.ts         # Utility functions (cn helper)
│   ├── types/
│   │   └── events.ts        # TypeScript type definitions
│   ├── pages/
│   │   └── ChatPage.tsx     # Chat UI
│   ├── App.tsx              # Route definitions
│   ├── main.tsx             # Entry point
│   └── index.css            # Global styles + Tailwind
├── components.json          # shadcn/ui configuration
├── vite.config.ts           # Vite configuration with proxy
└── package.json
```

## Features

### Workflow Demo Route (`/`)
- Select from available presets: `simple_pipeline`, `deep_research`, `multi_agent_crew`
- Start/stop workflow execution
- View real-time status

### Chat Route (`/chat`)
- Accepts user prompt input
- Creates a new IVCAP chat job per submit
- Streams `chat:token:*` events into incremental assistant output
- Uses AI SDK v6 UI message state as transcript source-of-truth

### Event Stream
- Live event display with auto-scroll
- Color-coded by event type (workflow, phase, agent, task)
- Timestamps and status indicators

### Results Summary
- Phases completed
- Agents executed
- Total events emitted
- Execution duration

## Development

### Adding Components

Use the shadcn CLI to add more UI components:

```bash
pnpm dlx shadcn@latest add [component-name]
```

Browse available components at [ui.shadcn.com](https://ui.shadcn.com/docs/components)

### Architecture

```
┌─────────────────┐   Jobs API (HTTP)    ┌──────────────────────────┐
│  React Client   │ ──────────────────▶  │  IVCAP Platform API       │
│                 │                     │  (/1/services2/...)       │
│  useWorkflow    │ ◀──────────────────  │  - creates job            │
│  hook manages   │    status + events   │  - exposes job-events     │
│  state          │                     └───────────┬───────────────┘
└─────────────────┘                                 │
                                                    │ runs
                                                    ▼
                                          ┌──────────────────────────┐
                                          │ Workflow Simulator Tool   │
                                          │ (your deployed service)   │
                                          └──────────────────────────┘
```

The client creates and monitors jobs via the IVCAP Jobs API:

- `POST /1/services2/{service_urn}/jobs` (create job)
- `GET /1/services2/{service_urn}/jobs/{job_id}` (poll status)
- `GET /1/services2/{service_urn}/jobs/{job_id}/events` (best-effort fetch events for display)

> **Auth note:** `VITE_AUTH_TOKEN` is used for client -> IVCAP Jobs API calls. LiteLLM proxy authentication is handled by the backend via `LITELLM_API_KEY`.
