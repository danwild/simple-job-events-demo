import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EventStream } from "@/components/EventStream"
import { useWorkflow } from "@/hooks/useWorkflow"
import type { PresetName } from "@/types/events"

const PRESETS: { id: PresetName; label: string; description: string }[] = [
  { id: 'simple_pipeline', label: 'Simple Pipeline', description: 'Basic 3-step workflow' },
  { id: 'deep_research', label: 'Deep Research', description: 'Multi-phase research workflow' },
  { id: 'multi_agent_crew', label: 'Multi-Agent Crew', description: 'CrewAI-style agents' },
]

function App() {
  const [selectedPreset, setSelectedPreset] = useState<PresetName>('simple_pipeline')
  const { state, startWorkflow, reset, isRunning } = useWorkflow()

  const handleStart = () => {
    startWorkflow(selectedPreset, 0.5) // Use 0.5x timing for faster demo
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-4xl space-y-8">
        {/* Header */}
        <header className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">
            IVCAP Job Events Demo
          </h1>
          <p className="text-muted-foreground">
            Workflow Simulator for multi-agent pipelines
          </p>
        </header>

        {/* Workflow Control */}
        <Card>
          <CardHeader>
            <CardTitle>Workflow Control</CardTitle>
            <CardDescription>
              Select a preset and start a workflow simulation
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Preset Selection */}
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <Badge
                  key={preset.id}
                  variant={selectedPreset === preset.id ? 'default' : 'outline'}
                  className="cursor-pointer transition-colors hover:bg-primary/80"
                  onClick={() => !isRunning && setSelectedPreset(preset.id)}
                >
                  {preset.label}
                </Badge>
              ))}
            </div>

            {/* Selected Preset Info */}
            <p className="text-sm text-muted-foreground">
              {PRESETS.find(p => p.id === selectedPreset)?.description}
            </p>

            {/* Action Buttons */}
            <div className="flex gap-2">
              <Button
                onClick={handleStart}
                disabled={isRunning}
              >
                {isRunning ? 'Running...' : 'Start Workflow'}
              </Button>
              {state.status !== 'idle' && (
                <Button
                  variant="outline"
                  onClick={reset}
                  disabled={isRunning}
                >
                  Reset
                </Button>
              )}
            </div>

            {/* Status Indicator */}
            {state.status !== 'idle' && (
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">Status:</span>
                <Badge variant={
                  state.status === 'running' ? 'default' :
                  (state.status === 'success' || state.status === 'complete') ? 'secondary' :
                  'destructive'
                }>
                  {state.status.toUpperCase()}
                </Badge>
                {(state.status === 'error' || state.status === 'failed') && state.error && (
                  <span className="text-destructive text-xs">
                    {state.error}
                  </span>
                )}
                {state.jobId && (
                  <span className="text-muted-foreground text-xs">
                    Job: {state.jobId}
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Event Stream */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Event Stream</span>
              {state.events.length > 0 && (
                <Badge variant="outline">{state.events.length} events</Badge>
              )}
            </CardTitle>
            <CardDescription>
              Real-time job events from the workflow simulator
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EventStream events={state.events} eventsConnectionStatus={state.eventsConnectionStatus} />
          </CardContent>
        </Card>

        {/* Completion Summary */}
        {(state.status === 'success' || state.status === 'complete') && (
          <Card>
            <CardHeader>
              <CardTitle>Workflow Complete</CardTitle>
              <CardDescription>
                Successfully processed {state.events.length} events
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {/* Error Display */}
        {state.error && (
          <Card className="border-destructive">
            <CardHeader>
              <CardTitle className="text-destructive">Error</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{state.error}</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

export default App
