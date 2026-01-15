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
 * @param timingMultiplier - Scale factor for delays (0.5 = faster, 2.0 = slower)
 * @returns Job ID for subscribing to events
 */
export async function createJob(
  preset: PresetName,
  timingMultiplier: number = 1.0
): Promise<string> {
  const parameters: JobRequest = {
    $schema: REQUEST_SCHEMA,
    preset_name: preset,
    timing_multiplier: timingMultiplier,
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
  
  console.log('[DEBUG] Fetching events from:', eventsUrl)
  
  fetch(eventsUrl, {
    headers: {
      ...(AUTH_TOKEN && { 'Authorization': `Bearer ${AUTH_TOKEN}` }),
    },
    signal: abortController.signal,
  })
    .then(async (response) => {
      console.log('[DEBUG] Events response status:', response.status)
      console.log('[DEBUG] Events response headers:', Object.fromEntries(response.headers.entries()))
      
      const text = await response.text()
      console.log('[DEBUG] Events response body:', text)
      
      if (!response.ok) {
        throw new Error(`Events request failed: ${response.status} - ${text}`)
      }
      
      // Try to parse as JSON (could be array of events or single object)
      try {
        const data = JSON.parse(text)
        console.log('[DEBUG] Parsed events data:', data)
        
        // Handle array of events
        const events = Array.isArray(data) ? data : (data.events || data.items || [data])
        
        for (const item of events) {
          const jobEvent: JobEvent = {
            step_id: item.step_id || item.stepId || item['step-id'] || 'unknown',
            message: item.message || item.msg || '',
            finished: item.finished ?? false,
            timestamp: new Date(item.timestamp || Date.now()),
            type: getEventType(item.step_id || item.stepId || item['step-id'] || ''),
          }
          onEvent(jobEvent)
        }
      } catch (parseErr) {
        console.log('[DEBUG] Response is not JSON, raw text:', text)
      }
      
      onComplete()
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        console.error('[DEBUG] Events fetch error:', err)
        onError(err instanceof Error ? err : new Error(String(err)))
      }
    })
  
  // Return cleanup function
  return () => {
    abortController.abort()
  }
}
