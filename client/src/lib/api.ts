/**
 * IVCAP API Client
 * 
 * Handles job creation and event streaming via the IVCAP Jobs API.
 */

import type { JobRequest, JobEvent, PresetName } from '@/types/events'
import { getEventType } from '@/types/events'

/** IVCAP API base URL from environment */
const API_URL = import.meta.env.VITE_API_URL || 'https://develop.ivcap.net'

/** Auth token from environment */
const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN || ''

/** Service URN for the workflow simulator */
const SERVICE_URN = import.meta.env.VITE_SERVICE_URN || 'urn:ivcap:service:f82da254-5025-5d94-9186-e76fa45bb7cc'

/** Request schema for the workflow simulator */
const REQUEST_SCHEMA = 'urn:sd:schema.workflow-simulator.request.1'

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
 * Fetch job events from the IVCAP API
 * 
 * @param jobId - The job ID to fetch events for
 * @param onEvent - Callback for each event
 * @param onComplete - Callback when done
 * @param onError - Callback on error
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
  const maxMessages = 100
  const maxWaitSeconds = 25
  
  console.log('[DEBUG] Fetching events from:', eventsUrl)

  const markConnected = () => {
    if (!hasConnected) {
      hasConnected = true
      onComplete()
    }
  }

  const parseEventPayload = (payload: unknown, fallback?: Record<string, unknown>): JobEvent | null => {
    if (payload == null) return null

    let data = payload
    if (typeof data === 'string') {
      const trimmed = data.trim()
      if (!trimmed) return null
      try {
        data = JSON.parse(trimmed)
      } catch {
        return {
          step_id: 'unknown',
          message: trimmed,
          finished: false,
          timestamp: new Date(),
          type: getEventType(''),
        }
      }
    }

    const record = data as Record<string, unknown>
    const stepId = (record.step_id as string)
      || (record.stepId as string)
      || (record['step-id'] as string)
      || (record.eventID as string)
      || (record.EventID as string)
      || (record.SeqID as string)
      || (record.seqId as string)
      || (fallback?.eventID as string)
      || (fallback?.EventID as string)
      || (fallback?.SeqID as string)
      || 'unknown'

    const message = (record.message as string)
      || (record.msg as string)
      || JSON.stringify(record)

    return {
      step_id: stepId,
      message,
      finished: (record.finished as boolean) ?? (record.Finished as boolean) ?? false,
      timestamp: new Date(
        (record.timestamp as string)
        || (record.Timestamp as string)
        || (fallback?.timestamp as string)
        || (fallback?.Timestamp as string)
        || Date.now()
      ),
      type: getEventType(stepId),
    }
  }

  const parseSseText = (text: string): Array<{ id?: string; data?: string }> => {
    const events: Array<{ id?: string; data?: string }> = []
    const lines = text.split(/\r?\n/)
    let currentId: string | undefined
    let dataLines: string[] = []

    const pushEvent = () => {
      if (currentId || dataLines.length > 0) {
        events.push({
          id: currentId,
          data: dataLines.join('\n'),
        })
      }
      currentId = undefined
      dataLines = []
    }

    for (const line of lines) {
      if (line === '') {
        pushEvent()
        continue
      }
      if (line.startsWith(':')) continue
      if (line.startsWith('id:')) {
        currentId = line.slice(3).trim()
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }

    pushEvent()
    return events
  }

  const emitFromResponse = (raw: unknown) => {
    if (raw == null) return

    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (!trimmed) return
      if (trimmed.startsWith('id:') || trimmed.startsWith('data:') || trimmed.includes('\ndata:')) {
        const parsed = parseSseText(trimmed)
        for (const entry of parsed) {
          if (entry.id) lastSeqId = entry.id
          const payload = entry.data ?? ''
          const event = parseEventPayload(payload, entry.id ? { SeqID: entry.id } : undefined)
          if (event) onEvent(event)
        }
        return
      }
      const parsed = parseEventPayload(trimmed)
      if (parsed) onEvent(parsed)
      return
    }

    const items = Array.isArray(raw)
      ? raw
      : (raw as Record<string, unknown>).events || (raw as Record<string, unknown>).items || [raw]

    for (const entry of items as Array<Record<string, unknown>>) {
      const seqId = (entry.SeqID as string) || (entry.seqId as string) || null
      if (seqId) lastSeqId = seqId

      const payload = (entry as Record<string, unknown>).data ?? entry
      const parsed = parseEventPayload(payload, entry)
      if (parsed) {
        onEvent(parsed)
      }
    }
  }

  const poll = async () => {
    while (!abortController.signal.aborted) {
      const url = new URL(eventsUrl)
      url.searchParams.set('max-messages', String(maxMessages))
      url.searchParams.set('max-wait-time', String(maxWaitSeconds))

      const headers: Record<string, string> = {}
      if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`
      if (lastSeqId) headers['Last-Event-ID'] = lastSeqId

      const response = await fetch(url.toString(), {
        headers,
        signal: abortController.signal,
      })

      console.log('[DEBUG] Events response status:', response.status)

      if (response.status === 204) {
        markConnected()
        continue
      }

      if (!response.ok && response.status !== 101) {
        const text = await response.text()
        throw new Error(`Events request failed: ${response.status} - ${text}`)
      }

      markConnected()

      const text = await response.text()
      if (!text.trim()) {
        continue
      }

      try {
        emitFromResponse(JSON.parse(text))
      } catch {
        emitFromResponse(text)
      }
    }
  }

  void poll().catch((err) => {
    const error = err instanceof Error ? err : new Error(String(err))
    if (error.name !== 'AbortError') {
      console.error('[DEBUG] Events fetch error:', error)
      onError(error)
    }
  })
  
  // Return cleanup function
  return () => {
    abortController.abort()
  }
}
