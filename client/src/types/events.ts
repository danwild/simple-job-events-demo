/**
 * IVCAP Job Events Type Definitions
 */

/** Available workflow presets */
export type PresetName = 'deep_research' | 'multi_agent_crew' | 'simple_pipeline'

/** Request payload for creating a job */
export interface JobRequest {
  $schema: string
  preset_name: PresetName
  timing_multiplier?: number
}

/** Event type based on step_id prefix */
export type EventType = 'workflow' | 'phase' | 'agent' | 'task'

/** A single job event from the event stream */
export interface JobEvent {
  step_id: string
  message: string
  finished: boolean
  timestamp: Date
  type: EventType
}

/** Status values from IVCAP job-read endpoint */
export type JobStatus = 'scheduled' | 'pending' | 'running' | 'executing' | 'success' | 'complete' | 'succeeded' | 'error' | 'failed'

/** Workflow status in the UI is exclusively the IVCAP job status (plus idle) */
export type WorkflowStatus = 'idle' | JobStatus

export type EventsConnectionStatus = 'idle' | 'waiting' | 'querying' | 'connected' | 'error'

/** Complete workflow state for UI */
export interface WorkflowState {
  status: WorkflowStatus
  /** Status of connecting/fetching job-events (best-effort) */
  eventsConnectionStatus?: EventsConnectionStatus | null
  jobId: string | null
  /** Local timestamp when the job was submitted */
  submittedAt: Date | null
  /** Local timestamp when job first entered executing */
  executingAt: Date | null
  /** Local timestamp when job exited (terminal state) */
  finishedAt: Date | null
  events: JobEvent[]
  error: string | null
}

/** Parse event type from step_id */
export function getEventType(stepId: string): EventType {
  if (stepId.startsWith('workflow:')) return 'workflow'
  if (stepId.startsWith('phase:')) return 'phase'
  if (stepId.includes(':task-')) return 'task'
  if (stepId.startsWith('agent:')) return 'agent'
  return 'task'
}
