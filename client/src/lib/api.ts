/**
 * IVCAP API Client
 * 
 * Handles job creation and event streaming via the IVCAP Jobs API.
 */

import type { ChatJobRequest, ChatMessage, JobRequest, JobEvent, PresetName } from '@/types/events'
import { getEventType } from '@/types/events'

/** IVCAP API base URL from environment */
const API_URL = import.meta.env.VITE_API_URL || 'https://develop.ivcap.net'

/** Auth token from environment */
const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN || ''

/** Service URN for the workflow simulator */
const SERVICE_URN = import.meta.env.VITE_SERVICE_URN || 'urn:ivcap:service:f82da254-5025-5d94-9186-e76fa45bb7cc'

/** Request schema for the workflow simulator */
const REQUEST_SCHEMA = 'urn:sd:schema.workflow-simulator.request.1'
const CHAT_REQUEST_SCHEMA = 'urn:sd:schema.workflow-simulator.chat.request.1'

/**
 * Create a workflow job via IVCAP Jobs API
 * 
 * @param preset - The workflow preset to run
 * @returns Job ID for subscribing to events
 */
export interface CreateJobOptions {
  totalRunTimeSeconds?: number
  tickIntervalSeconds?: number
}

export interface CreateChatJobOptions {
  model?: string
  temperature?: number
  maxTokens?: number
}

export async function createJob(
  preset: PresetName,
  options: CreateJobOptions = {}
): Promise<string> {
  const parameters: JobRequest = {
    $schema: REQUEST_SCHEMA,
    preset_name: preset,
  }

  if (Number.isFinite(options.totalRunTimeSeconds)) {
    parameters.total_run_time_seconds = options.totalRunTimeSeconds
  }

  if (Number.isFinite(options.tickIntervalSeconds)) {
    parameters.tick_interval_seconds = options.tickIntervalSeconds
  }

  const response = await fetch(`${API_URL}/1/services2/${encodeURIComponent(SERVICE_URN)}/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AUTH_TOKEN && { 'Authorization': `Bearer ${AUTH_TOKEN}` }),
    },
    body: JSON.stringify(parameters),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Job creation failed: ${response.status} - ${errorText}`)
  }

  const result = await response.json()
  
  // IVCAP Jobs API returns the job ID in the response (field name varies)
  const jobId = result.id || result['job-id'] || result.job_id
  if (!jobId) {
    throw new Error('Job creation response missing job ID')
  }
  
  return jobId
}

export async function createChatJob(
  messages: ChatMessage[],
  options: CreateChatJobOptions = {}
): Promise<string> {
  if (!messages.length) {
    throw new Error('Cannot create chat job: messages is empty')
  }

  const parameters: ChatJobRequest = {
    $schema: CHAT_REQUEST_SCHEMA,
    messages,
  }

  if (options.model) {
    parameters.model = options.model
  }
  if (Number.isFinite(options.temperature)) {
    parameters.temperature = options.temperature
  }
  if (Number.isFinite(options.maxTokens)) {
    parameters.max_tokens = options.maxTokens
  }

  const response = await fetch(`${API_URL}/1/services2/${encodeURIComponent(SERVICE_URN)}/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AUTH_TOKEN && { 'Authorization': `Bearer ${AUTH_TOKEN}` }),
    },
    body: JSON.stringify(parameters),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Chat job creation failed: ${response.status} - ${errorText}`)
  }

  const result = await response.json()
  const jobId = result.id || result['job-id'] || result.job_id
  if (!jobId) {
    throw new Error('Chat job creation response missing job ID')
  }
  return jobId
}

export function isChatTokenEvent(event: JobEvent): boolean {
  return event.step_id.startsWith('chat:token:') || event.step_id.startsWith('chat:tokens:')
}

export function getChatTokenText(event: JobEvent): string {
  return isChatTokenEvent(event) ? event.message : ''
}

export interface JobRead {
  status: string
  errorMessage?: string
  finishedAt?: string
}

/**
 * Read a job's status via IVCAP Jobs API
 *
 * GET /1/services2/{service_id}/jobs/{id}
 */
export async function readJob(jobId: string): Promise<JobRead> {
  const url = `${API_URL}/1/services2/${encodeURIComponent(SERVICE_URN)}/jobs/${encodeURIComponent(jobId)}`

  const response = await fetch(url, {
    headers: {
      ...(AUTH_TOKEN && { 'Authorization': `Bearer ${AUTH_TOKEN}` }),
    },
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Job read failed: ${response.status} - ${text}`)
  }

  const data = text ? JSON.parse(text) : {}
  return {
    status: (data.status ?? 'unknown') as string,
    errorMessage: data['error-message'] ?? data.error_message ?? data.errorMessage,
    finishedAt: data['finished-at'] ?? data.finished_at ?? data.finishedAt,
  }
}

/**
 * Fetch job events from the IVCAP API via SSE (Server-Sent Events).
 *
 * The events endpoint returns `text/event-stream`. Each SSE event carries a
 * JSON envelope:
 *
 *   id:00002014
 *   data:{"SeqID":"00002014","eventID":"UUID","type":"ivcap.job.event",
 *         "schema":"urn:ivcap:schema:service.event.step.start.1",
 *         "timestamp":"ISO-8601",
 *         "data":{"name":"timer:tick:1","options":{"message":"Tick 1"}}}
 *
 * We use `response.body.getReader()` to process events incrementally (rather
 * than `response.text()` which would block until the stream closes).
 *
 * @param jobId - The job ID to fetch events for
 * @param onEvent - Callback for each parsed event
 * @param onComplete - Callback once the first successful response arrives
 * @param onError - Callback on fatal error
 * @returns Cleanup function to abort the request
 */
export function subscribeToJobEvents(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  onComplete: () => void,
  onError: (error: Error) => void
): () => void {
  const eventsUrl = `${API_URL}/1/services2/${encodeURIComponent(SERVICE_URN)}/jobs/${encodeURIComponent(jobId)}/events`
  const abortController = new AbortController()
  let lastSeqId: string | null = null
  let hasConnected = false
  let sawTerminalStatus = false
  const maxMessages = 100
  const maxWaitSeconds = 20
  const requestTimeoutMs = 35_000 // client-side timeout: slightly above server's max-wait-time
  const maxConsecutiveErrors = 5

  console.log('[events] Subscribing to:', eventsUrl)

  const markConnected = () => {
    if (!hasConnected) {
      hasConnected = true
      onComplete()
    }
  }

  // ---------------------------------------------------------------------------
  // IVCAP envelope parsing
  // ---------------------------------------------------------------------------

  /**
   * Parse an IVCAP event envelope into a UI-friendly JobEvent.
   *
   * Envelope types:
   *  - ivcap.job.event  (step start / finish)
   *  - ivcap.job.status (job status change)
   *  - ivcap.job.result (job result available)
   */
  const parseIvcapEnvelope = (envelope: Record<string, unknown>): JobEvent | null => {
    const ivcapType = envelope.type as string | undefined
    const schema = (envelope.schema as string) || ''
    const timestamp = new Date((envelope.timestamp as string) || Date.now())

    if (ivcapType === 'ivcap.job.event') {
      const inner = envelope.data as Record<string, unknown> | null
      if (!inner) return null

      const stepId = (inner.name as string) || 'unknown'
      const options = inner.options as Record<string, unknown> | null
      const message = (options?.message as string) || ''
      const finished = schema.includes('step.finish')

      return {
        step_id: stepId,
        message: message || (finished ? 'completed' : 'started'),
        finished,
        timestamp,
        type: getEventType(stepId),
      }
    }

    if (ivcapType === 'ivcap.job.status') {
      const inner = envelope.data as Record<string, unknown> | null
      const status = (inner?.status as string) || 'unknown'
      const terminalStatuses = ['succeeded', 'success', 'complete', 'failed', 'error']
      if (terminalStatuses.includes(status)) {
        sawTerminalStatus = true
      }
      return {
        step_id: 'job:status',
        message: `Job status: ${status}`,
        finished: true,
        timestamp,
        type: 'workflow',
      }
    }

    if (ivcapType === 'ivcap.job.result') {
      const inner = envelope.data as Record<string, unknown> | null
      return {
        step_id: 'job:result',
        message: `Result: ${(inner?.['result-urn'] as string) || 'available'}`,
        finished: true,
        timestamp,
        type: 'workflow',
      }
    }

    // Unknown envelope – fall back to flat parsing
    return parseFlatEvent(envelope)
  }

  /** Fallback: try to interpret a record without the IVCAP envelope wrapper. */
  const parseFlatEvent = (record: Record<string, unknown>): JobEvent | null => {
    const stepId = (record.step_id as string)
      || (record.stepId as string)
      || (record['step-id'] as string)
      || 'unknown'

    const message = (record.message as string)
      || (record.msg as string)
      || JSON.stringify(record)

    return {
      step_id: stepId,
      message,
      finished: (record.finished as boolean) ?? false,
      timestamp: new Date((record.timestamp as string) || Date.now()),
      type: getEventType(stepId),
    }
  }

  // ---------------------------------------------------------------------------
  // SSE stream processing
  // ---------------------------------------------------------------------------

  /** Process a single SSE `data:` payload (a JSON string). */
  const processDataLine = (jsonStr: string) => {
    const trimmed = jsonStr.trim()
    if (!trimmed) return
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const seqId = parsed.SeqID as string
      if (seqId) lastSeqId = seqId

      const event = parseIvcapEnvelope(parsed)
      if (event) onEvent(event)
    } catch (err) {
      console.warn('[events] Failed to parse event JSON:', err, trimmed.slice(0, 200))
    }
  }

  /** Parse a single SSE event block (the text between blank-line separators). */
  const processSseBlock = (block: string) => {
    if (!block.trim()) return

    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) {
        const sseId = line.slice(3).trim()
        if (sseId) lastSeqId = sseId
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
      // skip comments (:), event:, retry:, etc.
    }

    if (dataLines.length > 0) {
      processDataLine(dataLines.join('\n'))
    }
  }

  /**
   * Read an SSE response body incrementally using the ReadableStream API.
   * Events are emitted to `onEvent` as soon as each SSE block is complete.
   */
  const readSseStream = async (response: Response) => {
    const reader = response.body?.getReader()
    if (!reader) {
      // Fallback: read entire body at once (non-streaming environment)
      const text = await response.text()
      for (const block of text.split('\n\n')) {
        processSseBlock(block)
      }
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // SSE events are separated by blank lines (\n\n)
        const parts = buffer.split('\n\n')
        buffer = parts.pop() || '' // keep the incomplete trailing part

        for (const block of parts) {
          processSseBlock(block)
        }
      }

      // Process any remaining data in the buffer
      if (buffer.trim()) {
        processSseBlock(buffer)
      }
    } finally {
      reader.releaseLock()
    }
  }

  // ---------------------------------------------------------------------------
  // Long-poll loop
  // ---------------------------------------------------------------------------

  const poll = async () => {
    let consecutiveErrors = 0

    while (!abortController.signal.aborted && !sawTerminalStatus) {
      try {
        const url = new URL(eventsUrl)
        url.searchParams.set('max-messages', String(maxMessages))
        url.searchParams.set('max-wait-time', String(maxWaitSeconds))

        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
        }
        if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`
        if (lastSeqId) headers['Last-Event-ID'] = lastSeqId

        console.log('[events] Fetching:', url.toString(), lastSeqId ? `(after ${lastSeqId})` : '(initial)')

        // Combine the caller's abort signal with a per-request timeout so
        // hung connections don't block forever.
        const timeoutSignal = AbortSignal.timeout(requestTimeoutMs)
        const combinedSignal = AbortSignal.any([abortController.signal, timeoutSignal])

        const response = await fetch(url.toString(), {
          headers,
          signal: combinedSignal,
        })

        console.log('[events] Response:', response.status, response.headers.get('content-type'))

        if (response.status === 204) {
          markConnected()
          consecutiveErrors = 0
          continue
        }

        if (!response.ok && response.status !== 101) {
          const text = await response.text()
          throw new Error(`Events request failed: ${response.status} - ${text}`)
        }

        markConnected()

        const contentType = response.headers.get('content-type') || ''

        if (contentType.includes('text/event-stream')) {
          // SSE stream – read incrementally so events appear in real-time
          await readSseStream(response)
        } else {
          // JSON or other – read the whole body and parse
          const text = await response.text()
          if (!text.trim()) {
            consecutiveErrors = 0
            continue
          }

          try {
            const json = JSON.parse(text)
            const items: unknown[] = Array.isArray(json)
              ? json
              : ((json as Record<string, unknown>).events as unknown[])
                || ((json as Record<string, unknown>).items as unknown[])
                || [json]

            for (const item of items) {
              const rec = item as Record<string, unknown>
              const seqId = rec.SeqID as string
              if (seqId) lastSeqId = seqId
              const event = parseIvcapEnvelope(rec)
              if (event) onEvent(event)
            }
          } catch {
            // Last resort: try treating the body as SSE text
            for (const block of text.split('\n\n')) {
              processSseBlock(block)
            }
          }
        }

        // Successful iteration — reset error counter
        consecutiveErrors = 0
      } catch (err) {
        // If the caller aborted, exit cleanly
        if (abortController.signal.aborted) return

        consecutiveErrors++
        console.warn(`[events] Poll error (${consecutiveErrors}/${maxConsecutiveErrors}):`, err)

        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw err // give up after too many consecutive failures
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, capped at 10s
        const delay = Math.min(1000 * 2 ** (consecutiveErrors - 1), 10_000)
        console.log(`[events] Retrying in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  void poll().catch((err) => {
    const error = err instanceof Error ? err : new Error(String(err))
    if (error.name !== 'AbortError' && error.name !== 'TimeoutError') {
      console.error('[events] Fetch error:', error)
      onError(error)
    }
  })

  // Return cleanup function
  return () => {
    abortController.abort()
  }
}
