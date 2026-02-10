import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EventStream } from '@/components/EventStream'
import { useChatJobEvents } from '@/hooks/useChatJobEvents'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMessageText(parts: { type: string; text?: string }[]): string {
  return parts
    .filter(part => part.type === 'text')
    .map(part => part.text ?? '')
    .join('')
}

// ---------------------------------------------------------------------------
// Example prompts for quick testing
// ---------------------------------------------------------------------------

const EXAMPLE_PROMPTS = [
  {
    label: 'AI Agent Architectures',
    text: 'Explain the core design patterns behind modern AI agent architectures. Cover: ReAct (reasoning + acting), tool-use and function calling, multi-agent orchestration, and memory/context management. For each pattern, describe how it works, when you would choose it, its limitations, and give a concrete example of a framework or system that implements it (e.g. LangGraph, CrewAI, AutoGen, etc.).',
  },
  {
    label: 'RAG vs Fine-tuning',
    text: 'Compare retrieval-augmented generation (RAG) and fine-tuning as strategies for customizing LLM behavior. When should you choose one over the other? What are the cost, latency, and accuracy trade-offs? Give a concrete example scenario for each.',
  },
  {
    label: 'Quick test',
    text: 'What are the three most important things to consider when designing an event-driven architecture?',
  },
]

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

function formatDelta(from: Date | null, to: Date | null): string | null {
  if (!from || !to) return null
  const ms = Math.max(0, to.getTime() - from.getTime())
  return `${(ms / 1000).toFixed(2)}s`
}

// ---------------------------------------------------------------------------
// Thinking dots animation (pure CSS via inline style tag)
// ---------------------------------------------------------------------------

const thinkingDotsStyle = `
@keyframes chat-bounce {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}
@keyframes chat-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
`

function ThinkingIndicator({ statusMessage }: { statusMessage?: string | null }) {
  return (
    <div className="space-y-1.5 py-1">
      <div className="flex items-center gap-1">
        <style>{thinkingDotsStyle}</style>
        {[0, 1, 2].map(i => (
          <span
            key={i}
            className="inline-block h-2 w-2 rounded-full bg-muted-foreground/60"
            style={{
              animation: 'chat-bounce 1.4s infinite ease-in-out both',
              animationDelay: `${i * 0.16}s`,
            }}
          />
        ))}
      </div>
      {statusMessage && (
        <p className="text-[11px] leading-tight text-muted-foreground/70">
          {statusMessage}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timing pill (compact label + value)
// ---------------------------------------------------------------------------

function TimingPill({ label, value }: { label: string; value: string | null }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-muted-foreground/60">{label}:</span>
      <span className="font-mono font-medium tabular-nums">
        {value ?? 'Waiting...'}
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Chat page
// ---------------------------------------------------------------------------

export function ChatPage() {
  const [prompt, setPrompt] = useState('')
  const [debugOpen, setDebugOpen] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const {
    messages,
    submitPrompt,
    reset,
    isBusy,
    isStreaming,
    status,
    jobId,
    error,
    tokenEvents,
    eventsConnectionStatus,
    events,
    statusMessage,
    submittedAt,
    executingAt,
    firstEventAt,
    firstTokenAt,
    finishedAt,
  } = useChatJobEvents()

  const canSubmit = prompt.trim().length > 0 && !isBusy
  const showThinking = isBusy && !isStreaming

  const orderedMessages = useMemo(
    () => messages.filter(m => m.role === 'user' || m.role === 'assistant'),
    [messages],
  )

  // ---- Auto-scroll to bottom on new content ----
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [orderedMessages, isStreaming, showThinking])

  // ---- Auto-resize textarea ----
  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    // Cap at ~4 lines (roughly 6rem)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`
  }, [])

  useEffect(() => {
    resizeTextarea()
  }, [prompt, resizeTextarea])

  // ---- Submit handler ----
  const handleSubmit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    const value = prompt.trim()
    if (!value || isBusy) return
    setPrompt('')
    await submitPrompt(value)
  }

  // ---- Keyboard: Enter to send, Shift+Enter for newline ----
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSubmit()
    }
  }

  // ---- Status badge variant ----
  const statusBadgeVariant = (() => {
    switch (status) {
      case 'streaming':
        return 'default' as const
      case 'success':
        return 'secondary' as const
      case 'error':
        return 'destructive' as const
      default:
        return 'outline' as const
    }
  })()

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* ----------------------------------------------------------------- */}
      {/* Header                                                            */}
      {/* ----------------------------------------------------------------- */}
      <header className="flex shrink-0 items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">IVCAP Chat</h1>
          <Badge variant={statusBadgeVariant} className="text-xs">
            {status.toUpperCase()}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => setDebugOpen(prev => !prev)}
          >
            {debugOpen ? 'Hide Debug' : 'Debug'}
          </Button>
          <Button variant="ghost" size="sm" onClick={reset} disabled={isBusy && !messages.length}>
            Reset
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/">Workflow Demo</Link>
          </Button>
        </div>
      </header>

      {/* ----------------------------------------------------------------- */}
      {/* Messages area                                                     */}
      {/* ----------------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1">
        {/* Main chat column */}
        <div className="flex flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto max-w-2xl space-y-4">
              {orderedMessages.length === 0 && !isBusy && (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-10 w-10 opacity-30"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"
                    />
                  </svg>
                  <p className="text-sm">Send a message to start a conversation.</p>
                  <p className="text-xs opacity-60">
                    Each message creates an IVCAP job; tokens stream back via Job Events.
                  </p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {EXAMPLE_PROMPTS.map(example => (
                      <button
                        key={example.label}
                        type="button"
                        className="rounded-lg border bg-background px-3 py-2 text-left text-xs text-foreground shadow-sm transition-colors hover:bg-muted/60"
                        onClick={() => void submitPrompt(example.text)}
                      >
                        {example.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {orderedMessages.map((message, idx) => {
                const isUser = message.role === 'user'
                const text = getMessageText(message.parts)
                const isLastAssistant =
                  !isUser && idx === orderedMessages.length - 1

                return (
                  <div
                    key={message.id}
                    className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`relative max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                        isUser
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted/60'
                      }`}
                    >
                      {/* Message text */}
                      <div className="whitespace-pre-wrap">
                        {text}
                        {/* Blinking cursor while streaming */}
                        {isLastAssistant && isStreaming && (
                          <span
                            className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[2px] bg-current"
                            style={{ animation: 'chat-blink 1s step-end infinite' }}
                          />
                        )}
                      </div>

                      {/* Thinking indicator: show on the last assistant bubble if no tokens yet */}
                      {isLastAssistant && showThinking && !text && (
                        <ThinkingIndicator statusMessage={statusMessage} />
                      )}
                    </div>
                  </div>
                )
              })}

              {/* Error banner */}
              {error && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              {/* Scroll anchor */}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* --------------------------------------------------------------- */}
          {/* Input bar                                                        */}
          {/* --------------------------------------------------------------- */}
          <div className="shrink-0 border-t bg-background px-4 py-3">
            {/* Timing metrics bar -- visible when a job has been submitted */}
            {status !== 'idle' && submittedAt && (
              <div className="mx-auto mb-2.5 flex max-w-2xl flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                <TimingPill label="Executing" value={formatDelta(submittedAt, executingAt)} />
                <TimingPill label="First event" value={formatDelta(submittedAt, firstEventAt)} />
                <TimingPill label="First token" value={formatDelta(submittedAt, firstTokenAt)} />
                <TimingPill label="Complete" value={formatDelta(submittedAt, finishedAt)} />
              </div>
            )}
            <form
              className="mx-auto flex max-w-2xl items-end gap-2"
              onSubmit={handleSubmit}
            >
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isBusy ? 'Waiting for response...' : 'Send a message...'}
                disabled={isBusy}
                rows={1}
                className="flex-1 resize-none rounded-xl border bg-muted/30 px-4 py-2.5 text-sm shadow-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
              <Button
                type="submit"
                size="sm"
                disabled={!canSubmit}
                className="mb-px rounded-xl px-4"
              >
                {isBusy ? (
                  /* Simple spinner */
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                ) : (
                  /* Arrow-up send icon */
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-4 w-4"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 17a.75.75 0 0 1-.75-.75V5.612L5.29 9.77a.75.75 0 0 1-1.08-1.04l5.25-5.5a.75.75 0 0 1 1.08 0l5.25 5.5a.75.75 0 1 1-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0 1 10 17Z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </Button>
            </form>
            <p className="mx-auto mt-1.5 max-w-2xl text-center text-[11px] text-muted-foreground/50">
              Messages are routed via IVCAP Job Events. Latency depends on job scheduling + event delivery.
            </p>
          </div>
        </div>

        {/* --------------------------------------------------------------- */}
        {/* Collapsible debug panel (right side)                             */}
        {/* --------------------------------------------------------------- */}
        {debugOpen && (
          <aside className="flex w-96 shrink-0 flex-col border-l">
            {/* Diagnostics */}
            <div className="border-b px-4 py-3">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Job Diagnostics
              </h2>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant={statusBadgeVariant} className="text-[10px]">
                    {status.toUpperCase()}
                  </Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Job ID</span>
                  <span className="max-w-[180px] truncate font-mono text-[10px]">
                    {jobId || '--'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Token Events</span>
                  <span className="font-mono">{tokenEvents}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Events Stream</span>
                  <span>{eventsConnectionStatus}</span>
                </div>
              </div>
            </div>

            {/* Raw events */}
            <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Raw Job Events
              </h2>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <EventStream events={events} eventsConnectionStatus={eventsConnectionStatus} />
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
