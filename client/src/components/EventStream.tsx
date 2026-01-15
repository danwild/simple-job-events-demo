/**
 * EventStream Component
 * 
 * Displays a scrollable list of job events with auto-scroll,
 * color-coded by event type.
 */

import { useEffect, useRef } from 'react'
import { Badge } from '@/components/ui/badge'
import type { JobEvent, EventType, EventsConnectionStatus } from '@/types/events'

interface EventStreamProps {
  events: JobEvent[]
  eventsConnectionStatus?: EventsConnectionStatus | null
  className?: string
}

/** Get badge variant based on event type */
function getEventBadgeVariant(type: EventType): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (type) {
    case 'workflow':
      return 'default'
    case 'phase':
      return 'secondary'
    case 'agent':
      return 'outline'
    case 'task':
      return 'outline'
    default:
      return 'outline'
  }
}

/** Get display label for event type */
function getEventTypeLabel(type: EventType): string {
  switch (type) {
    case 'workflow':
      return 'WORKFLOW'
    case 'phase':
      return 'PHASE'
    case 'agent':
      return 'AGENT'
    case 'task':
      return 'TASK'
    default:
      return 'EVENT'
  }
}

/** Format timestamp for display */
function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  })
}

function getConnectionLabel(status?: EventsConnectionStatus | null): string | null {
  switch (status) {
    case 'waiting':
      return 'Waiting for job to start…'
    case 'querying':
      return 'Querying job-events…'
    case 'connected':
      return 'job-events connected'
    case 'error':
      return 'job-events unavailable'
    case 'idle':
    default:
      return null
  }
}

function getConnectionBadgeVariant(
  status?: EventsConnectionStatus | null
): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (status) {
    case 'connected':
      return 'secondary'
    case 'querying':
    case 'waiting':
      return 'outline'
    case 'error':
      return 'destructive'
    default:
      return 'outline'
  }
}

export function EventStream({ events, eventsConnectionStatus, className = '' }: EventStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events])

  const connLabel = getConnectionLabel(eventsConnectionStatus)

  if (events.length === 0) {
    return (
      <div className={`rounded-lg border border-dashed p-8 text-center text-muted-foreground ${className}`}>
        <div>No events yet.</div>
        <div className="mt-2 flex items-center justify-center gap-2">
          {connLabel ? (
            <Badge variant={getConnectionBadgeVariant(eventsConnectionStatus)} className="text-xs">
              {connLabel}
            </Badge>
          ) : (
            <span className="text-xs">Start a workflow to see events.</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className={`max-h-96 overflow-y-auto rounded-lg border bg-muted/30 p-2 font-mono text-sm ${className}`}
    >
      {connLabel && (
        <div className="sticky top-0 z-10 mb-2 flex justify-end bg-muted/30 p-1">
          <Badge variant={getConnectionBadgeVariant(eventsConnectionStatus)} className="text-xs">
            {connLabel}
          </Badge>
        </div>
      )}
      <div className="space-y-1">
        {events.map((event, index) => (
          <div
            key={`${event.step_id}-${index}`}
            className={`flex items-start gap-2 rounded px-2 py-1 ${
              event.finished ? 'opacity-70' : ''
            }`}
          >
            {/* Timestamp */}
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatTime(event.timestamp)}
            </span>

            {/* Event type badge */}
            <Badge
              variant={getEventBadgeVariant(event.type)}
              className="shrink-0 text-xs"
            >
              {getEventTypeLabel(event.type)}
            </Badge>

            {/* Status indicator */}
            <span className={`shrink-0 ${event.finished ? 'text-green-500' : 'text-blue-500'}`}>
              {event.finished ? '✓' : '→'}
            </span>

            {/* Message */}
            <span className="flex-1 wrap-break-word">
              {event.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
