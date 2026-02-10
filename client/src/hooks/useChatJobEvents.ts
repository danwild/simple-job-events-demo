import { useCallback, useMemo, useRef, useState } from 'react'
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
  status: ChatRunStatus
  jobId: string | null
  error: string | null
  tokenEvents: number
  eventsConnectionStatus: EventsConnectionStatus
  events: JobEvent[]
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

  const assistantIdRef = useRef<string | null>(null)
  const abortRef = useRef<(() => void) | null>(null)
  const pollRef = useRef<number | null>(null)
  const connectedRef = useRef(false)

  const cleanup = useCallback(() => {
    if (abortRef.current) {
      abortRef.current()
      abortRef.current = null
    }
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
    connectedRef.current = false
  }, [])

  const finalizeAssistant = useCallback(() => {
    const assistantId = assistantIdRef.current
    if (!assistantId) return

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
  }, [setMessages])

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
          setEventsConnectionStatus('querying')
          abortRef.current = subscribeToJobEvents(
            createdJobId,
            event => {
              setEvents(prev => [...prev, event])
              if (isChatTokenEvent(event) && !event.finished) {
                const token = getChatTokenText(event)
                if (token) {
                  setTokenEvents(prev => prev + 1)
                  appendAssistantChunk(token)
                }
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
          setStatus('success')
          return
        }
        if (terminalError.has(normalized)) {
          cleanup()
          finalizeAssistant()
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
  }, [appendAssistantChunk, cleanup, finalizeAssistant, messages, setMessages])

  const reset = useCallback(() => {
    cleanup()
    assistantIdRef.current = null
    setMessages([])
    setStatus('idle')
    setJobId(null)
    setError(null)
    setTokenEvents(0)
    setEvents([])
    setEventsConnectionStatus('idle')
  }, [cleanup, setMessages])

  const isBusy = useMemo(() => status === 'submitting' || status === 'streaming', [status])

  return {
    messages,
    submitPrompt,
    reset,
    isBusy,
    status,
    jobId,
    error,
    tokenEvents,
    eventsConnectionStatus,
    events,
  }
}
