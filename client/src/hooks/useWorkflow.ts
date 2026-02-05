/**
 * useWorkflow Hook
 * 
 * Manages the workflow execution lifecycle including job creation,
 * event streaming via SSE, and state updates.
 */

import { useState, useCallback, useRef } from 'react'
import type { WorkflowState, PresetName, JobEvent } from '@/types/events'
import { createJob, readJob, subscribeToJobEvents } from '@/lib/api'

const initialState: WorkflowState = {
  status: 'idle',
  eventsConnectionStatus: 'idle',
  jobId: null,
  submittedAt: null,
  executingAt: null,
  finishedAt: null,
  events: [],
  error: null,
}

export interface UseWorkflowReturn {
  /** Current workflow state */
  state: WorkflowState
  /** Start a new workflow */
  startWorkflow: (preset: PresetName, timingMultiplier?: number) => Promise<void>
  /** Reset to idle state */
  reset: () => void
  /** Whether a workflow is currently running */
  isRunning: boolean
}

export function useWorkflow(): UseWorkflowReturn {
  const [state, setState] = useState<WorkflowState>(initialState)
  const abortRef = useRef<(() => void) | null>(null)
  const pollRef = useRef<number | null>(null)
  const hasConnectedEventsRef = useRef(false)

  const cleanupRunning = useCallback(() => {
    if (abortRef.current) {
      abortRef.current()
      abortRef.current = null
    }
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
    hasConnectedEventsRef.current = false
  }, [])

  const addEvent = useCallback((event: JobEvent) => {
    setState(prev => ({
      ...prev,
      events: [...prev.events, event],
    }))
  }, [])

  const startWorkflow = useCallback(async (
    preset: PresetName,
    timingMultiplier: number = 1.0
  ) => {
    // Clean up any previous run
    cleanupRunning()

    const submittedAt = new Date()
    // Reset state and start running
    setState({
      status: 'pending',
      eventsConnectionStatus: 'waiting',
      jobId: null,
      submittedAt,
      executingAt: null,
      finishedAt: null,
      events: [],
      error: null,
    })

    try {
      // Create the job via IVCAP Jobs API
      const jobId = await createJob(preset, timingMultiplier)

      setState(prev => ({
        ...prev,
        jobId,
      }))

      const terminalSuccess = new Set(['success', 'complete', 'succeeded'])
      const terminalError = new Set(['error', 'failed'])
      const nonTerminal = new Set(['scheduled', 'pending', 'running', 'executing'])

      const pollOnce = async () => {
        try {
          const job = await readJob(jobId)
          const status = String(job.status || '').toLowerCase()

          // Always reflect the raw job status from IVCAP (this is the only status we show)
          const finishedAt = job.finishedAt ? new Date(job.finishedAt) : null
          setState(prev => {
            const shouldSetExecutingAt = status === 'executing' && prev.executingAt == null
            const shouldSetFinishedAt = (
              (terminalSuccess.has(status) || terminalError.has(status))
              && prev.finishedAt == null
            )
            return {
              ...prev,
              status: (status || 'pending') as WorkflowState['status'],
              executingAt: shouldSetExecutingAt ? new Date() : prev.executingAt,
              finishedAt: shouldSetFinishedAt ? (finishedAt || new Date()) : prev.finishedAt,
            }
          })

          if (terminalSuccess.has(status)) {
            cleanupRunning()
            setState(prev => ({
              ...prev,
              status: status as WorkflowState['status'],
            }))
          } else if (terminalError.has(status)) {
            cleanupRunning()
            setState(prev => ({
              ...prev,
              status: status as WorkflowState['status'],
              error: job.errorMessage || `Job ${status}`,
            }))
          } else if (
            nonTerminal.has(status)
            && (status === 'running' || status === 'executing')
            && !hasConnectedEventsRef.current
          ) {
            // Fetch events best-effort (UX). Only try once, and only after job is running.
            hasConnectedEventsRef.current = true
            setState(prev => ({
              ...prev,
              eventsConnectionStatus: 'querying',
            }))
            abortRef.current = subscribeToJobEvents(
              jobId,
              addEvent,
              () => {
                setState(prev => ({
                  ...prev,
                  eventsConnectionStatus: 'connected',
                }))
              },
              () => {
                // Best-effort: don't fail the workflow if job-events fails
                setState(prev => ({
                  ...prev,
                  eventsConnectionStatus: 'error',
                }))
              }
            )
          }
        } catch (e) {
          // Don't immediately fail the workflow on transient poll issues.
          // We'll continue polling and let terminal state drive completion.
          console.warn('Job polling failed:', e)
        }
      }

      // Poll immediately, then every 2s while running
      await pollOnce()
      pollRef.current = window.setInterval(pollOnce, 2000)

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      setState(prev => ({
        ...prev,
        status: 'error',
        error: errorMessage,
      }))
    }
  }, [addEvent, cleanupRunning])

  const reset = useCallback(() => {
    cleanupRunning()
    setState(initialState)
  }, [cleanupRunning])

  return {
    state,
    startWorkflow,
    reset,
    isRunning: state.status !== 'idle' && state.status !== 'success' && state.status !== 'complete' && state.status !== 'succeeded' && state.status !== 'error' && state.status !== 'failed',
  }
}
