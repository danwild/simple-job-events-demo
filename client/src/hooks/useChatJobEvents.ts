import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { useChat } from '@ai-sdk/react'
import { generateId } from 'ai'
import type { ChatMessage, EventsConnectionStatus, JobEvent } from '@/types/events'
import { createChatJob, getChatTokenText, isChatTokenEvent, readJob, subscribeToJobEvents } from '@/lib/api'

type ChatRunStatus = 'idle' | 'submitting' | 'streaming' | 'success' | 'error'

export interface UseChatJobEventsReturn {
  messages: UIMessage[]
  submitPrompt: (prompt: string) => Promise<void>
  reset: () => void
  isBusy: boolean
  /** True once tokens are actively streaming (isBusy && tokenEvents > 0) */
  isStreaming: boolean
  status: ChatRunStatus
  jobId: string | null
  error: string | null
  tokenEvents: number
  eventsConnectionStatus: EventsConnectionStatus
  events: JobEvent[]
  /** Latest non-token lifecycle status message (e.g. "Submitting chat request...") */
  statusMessage: string | null
  /** Timestamps for computing latency deltas */
  submittedAt: Date | null
  executingAt: Date | null
  firstEventAt: Date | null
  firstTokenAt: Date | null
  finishedAt: Date | null
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('')
}

function asChatMessages(messages: UIMessage[]): ChatMessage[] {
  return messages
    .filter(message => message.role === 'system' || message.role === 'user' || message.role === 'assistant')
    .map(message => ({
      role: message.role,
      content: getMessageText(message),
    }))
    .filter(message => message.content.trim().length > 0)
}

function buildUserMessage(prompt: string): UIMessage {
  return {
    id: generateId(),
    role: 'user',
    parts: [{ type: 'text', text: prompt, state: 'done' }],
  }
}

function buildAssistantMessage(id: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text: '', state: 'streaming' }],
  }
}

export function useChatJobEvents(): UseChatJobEventsReturn {
  const { messages, setMessages } = useChat()
  const [status, setStatus] = useState<ChatRunStatus>('idle')
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tokenEvents, setTokenEvents] = useState(0)
  const [eventsConnectionStatus, setEventsConnectionStatus] = useState<EventsConnectionStatus>('idle')
  const [events, setEvents] = useState<JobEvent[]>([])
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [submittedAt, setSubmittedAt] = useState<Date | null>(null)
  const [executingAt, setExecutingAt] = useState<Date | null>(null)
  const [firstEventAt, setFirstEventAt] = useState<Date | null>(null)
  const [firstTokenAt, setFirstTokenAt] = useState<Date | null>(null)
  const [finishedAt, setFinishedAt] = useState<Date | null>(null)

  const assistantIdRef = useRef<string | null>(null)
  const abortRef = useRef<(() => void) | null>(null)
  const pollRef = useRef<number | null>(null)
  const connectedRef = useRef(false)
  const firstEventRecordedRef = useRef(false)
  const firstTokenRecordedRef = useRef(false)

  // -- Adaptive typewriter animation -----------------------------------------
  // Batched tokens arrive as large chunks. Instead of dumping them all at once
  // we reveal text character-by-character, dynamically adjusting the speed so
  // that rendering is never the bottleneck:
  //   - Large queue (batch just landed) → render fast to catch up
  //   - Small queue (draining between batches) → render slowly for smoothness
  //   - Very large queue (>BURST_THRESHOLD) → emit multiple chars per tick
  const MIN_TICK_MS = 8          // fastest: ~125 chars/sec
  const MAX_TICK_MS = 40         // slowest: ~25 chars/sec
  const QUEUE_FAST_THRESHOLD = 50 // queue length at which we hit max speed
  const BURST_THRESHOLD = 200    // queue length above which we emit multi-char
  const BURST_CHARS = 5          // chars per tick when bursting

  const typewriterQueueRef = useRef('')
  const typewriterTimerRef = useRef<number | null>(null)

  // -- appendAssistantChunk (defined first; used by typewriter & finalizer) --
  const appendAssistantChunk = useCallback((chunk: string) => {
    const assistantId = assistantIdRef.current
    if (!assistantId) return

    setMessages(prev =>
      prev.map(message => {
        if (message.id !== assistantId) return message
        const firstTextPart = message.parts.find(part => part.type === 'text')
        const existing = firstTextPart && firstTextPart.type === 'text' ? firstTextPart.text : ''
        return {
          ...message,
          parts: [{ type: 'text', text: `${existing}${chunk}`, state: 'streaming' }],
        }
      })
    )
  }, [setMessages])

  // -- Typewriter animation functions ----------------------------------------
  const stopTypewriter = useCallback(() => {
    if (typewriterTimerRef.current != null) {
      window.clearTimeout(typewriterTimerRef.current)
      typewriterTimerRef.current = null
    }
  }, [])

  const flushTypewriter = useCallback(() => {
    stopTypewriter()
    const remaining = typewriterQueueRef.current
    typewriterQueueRef.current = ''
    if (remaining) {
      appendAssistantChunk(remaining)
    }
  }, [appendAssistantChunk, stopTypewriter])

  const startTypewriter = useCallback(() => {
    if (typewriterTimerRef.current != null) return // already running

    const scheduleNextTick = () => {
      const queue = typewriterQueueRef.current
      if (!queue) {
        // Queue drained – pause until more text is enqueued
        typewriterTimerRef.current = null
        return
      }

      // Adaptive speed: large queue → fast tick, small queue → slow tick
      const ratio = Math.min(queue.length / QUEUE_FAST_THRESHOLD, 1)
      const tickMs = MAX_TICK_MS - ratio * (MAX_TICK_MS - MIN_TICK_MS)

      // Burst mode: emit multiple chars when queue is very large
      const charsToEmit = queue.length > BURST_THRESHOLD
        ? Math.min(BURST_CHARS, queue.length)
        : 1

      typewriterTimerRef.current = window.setTimeout(() => {
        const current = typewriterQueueRef.current
        if (!current) {
          typewriterTimerRef.current = null
          return
        }
        const emitCount = Math.min(charsToEmit, current.length)
        typewriterQueueRef.current = current.slice(emitCount)
        appendAssistantChunk(current.slice(0, emitCount))
        scheduleNextTick()
      }, tickMs)
    }

    scheduleNextTick()
  }, [appendAssistantChunk])

  const enqueueTypewriterText = useCallback((text: string) => {
    typewriterQueueRef.current += text
    startTypewriter()
  }, [startTypewriter])

  // Clean up the typewriter timer on unmount
  useEffect(() => {
    return () => stopTypewriter()
  }, [stopTypewriter])

  // -- cleanup & finalizeAssistant ------------------------------------------
  const cleanup = useCallback(() => {
    stopTypewriter()
    if (abortRef.current) {
      abortRef.current()
      abortRef.current = null
    }
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
    connectedRef.current = false
  }, [stopTypewriter])

  const finalizeAssistant = useCallback(() => {
    const assistantId = assistantIdRef.current
    if (!assistantId) return

    // Instantly reveal any remaining queued typewriter text
    flushTypewriter()

    setMessages(prev =>
      prev.map(message => {
        if (message.id !== assistantId) return message
        return {
          ...message,
          parts: message.parts.map(part =>
            part.type === 'text'
              ? { ...part, state: 'done' }
              : part
          ),
        }
      })
    )
  }, [flushTypewriter, setMessages])

  const submitPrompt = useCallback(async (prompt: string) => {
    const trimmed = prompt.trim()
    if (!trimmed) return

    cleanup()
    setStatus('submitting')
    setError(null)
    setJobId(null)
    setTokenEvents(0)
    setEvents([])
    setEventsConnectionStatus('waiting')
    setStatusMessage(null)
    setSubmittedAt(new Date())
    setExecutingAt(null)
    setFirstEventAt(null)
    setFirstTokenAt(null)
    setFinishedAt(null)
    firstEventRecordedRef.current = false
    firstTokenRecordedRef.current = false

    const userMessage = buildUserMessage(trimmed)
    const assistantId = generateId()
    assistantIdRef.current = assistantId
    const assistantMessage = buildAssistantMessage(assistantId)

    const history = [...messages, userMessage]
    const chatMessages = asChatMessages(history)
    setMessages(history.concat(assistantMessage))

    try {
      const createdJobId = await createChatJob(chatMessages)
      setJobId(createdJobId)

      const terminalSuccess = new Set(['success', 'complete', 'succeeded'])
      const terminalError = new Set(['error', 'failed'])
      const nonTerminal = new Set(['scheduled', 'pending', 'running', 'executing'])

      const pollOnce = async () => {
        const job = await readJob(createdJobId)
        const normalized = String(job.status || '').toLowerCase()

        if ((normalized === 'running' || normalized === 'executing') && !connectedRef.current) {
          connectedRef.current = true
          setStatus('streaming')
          setExecutingAt(prev => prev ?? new Date())
          setEventsConnectionStatus('querying')
          abortRef.current = subscribeToJobEvents(
            createdJobId,
            event => {
              setEvents(prev => [...prev, event])

              // Record first event arrival time (any event type)
              if (!firstEventRecordedRef.current) {
                firstEventRecordedRef.current = true
                setFirstEventAt(new Date())
              }

              if (isChatTokenEvent(event) && !event.finished) {
                const token = getChatTokenText(event)
                if (token) {
                  // Record first token arrival time
                  if (!firstTokenRecordedRef.current) {
                    firstTokenRecordedRef.current = true
                    setFirstTokenAt(new Date())
                  }
                  setTokenEvents(prev => prev + 1)
                  enqueueTypewriterText(token)
                }
              }

              // Update status message from non-token chat:* events (start events only)
              if (
                event.step_id.startsWith('chat:') &&
                !isChatTokenEvent(event) &&
                !event.finished &&
                event.message
              ) {
                setStatusMessage(event.message)
              }
            },
            () => {
              setEventsConnectionStatus('connected')
            },
            streamError => {
              setEventsConnectionStatus('error')
              setError(streamError.message)
              setStatus('error')
              finalizeAssistant()
            }
          )
        }

        if (terminalSuccess.has(normalized)) {
          cleanup()
          finalizeAssistant()
          setFinishedAt(prev => prev ?? new Date())
          setStatus('success')
          return
        }
        if (terminalError.has(normalized)) {
          cleanup()
          finalizeAssistant()
          setFinishedAt(prev => prev ?? new Date())
          setStatus('error')
          setError(job.errorMessage || `Chat job ${normalized}`)
          return
        }
        if (!nonTerminal.has(normalized)) {
          cleanup()
          finalizeAssistant()
          setStatus('error')
          setError(`Unexpected job status: ${normalized || 'unknown'}`)
        }
      }

      await pollOnce()
      pollRef.current = window.setInterval(() => {
        void pollOnce().catch(pollError => {
          const message = pollError instanceof Error ? pollError.message : String(pollError)
          setError(message)
          setStatus('error')
          cleanup()
          finalizeAssistant()
        })
      }, 2000)
    } catch (submitError) {
      cleanup()
      finalizeAssistant()
      const message = submitError instanceof Error ? submitError.message : 'Unknown chat submission error'
      setError(message)
      setStatus('error')
    }
  }, [enqueueTypewriterText, cleanup, finalizeAssistant, messages, setMessages])

  const reset = useCallback(() => {
    cleanup()
    typewriterQueueRef.current = ''
    assistantIdRef.current = null
    firstEventRecordedRef.current = false
    firstTokenRecordedRef.current = false
    setMessages([])
    setStatus('idle')
    setJobId(null)
    setError(null)
    setTokenEvents(0)
    setEvents([])
    setEventsConnectionStatus('idle')
    setStatusMessage(null)
    setSubmittedAt(null)
    setExecutingAt(null)
    setFirstEventAt(null)
    setFirstTokenAt(null)
    setFinishedAt(null)
  }, [cleanup, setMessages])

  const isBusy = useMemo(() => status === 'submitting' || status === 'streaming', [status])
  const isStreaming = useMemo(() => isBusy && tokenEvents > 0, [isBusy, tokenEvents])

  return {
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
  }
}
