import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EventStream } from '@/components/EventStream'
import { useChatJobEvents } from '@/hooks/useChatJobEvents'

function getMessageText(parts: { type: string; text?: string }[]): string {
  return parts
    .filter(part => part.type === 'text')
    .map(part => part.text ?? '')
    .join('')
}

export function ChatPage() {
  const [prompt, setPrompt] = useState('')
  const {
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
  } = useChatJobEvents()

  const canSubmit = prompt.trim().length > 0 && !isBusy
  const orderedMessages = useMemo(
    () => messages.filter(message => message.role === 'user' || message.role === 'assistant'),
    [messages]
  )

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = prompt.trim()
    if (!value) return
    setPrompt('')
    await submitPrompt(value)
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">IVCAP Chat Demo</h1>
          <p className="text-muted-foreground">
            Submit a prompt, create an IVCAP chat job, and stream model output from Job Events.
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>Chat Input</CardTitle>
            <CardDescription>
              Each submit creates a new job using the `/chat` tool route.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <form className="space-y-3" onSubmit={handleSubmit}>
              <label className="block text-sm font-medium" htmlFor="chat-prompt">
                Message
              </label>
              <textarea
                id="chat-prompt"
                value={prompt}
                onChange={event => setPrompt(event.target.value)}
                rows={4}
                placeholder="Ask the assistant something..."
                className="w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex gap-2">
                <Button type="submit" disabled={!canSubmit}>
                  {isBusy ? 'Streaming...' : 'Send Message'}
                </Button>
                <Button type="button" variant="outline" onClick={reset} disabled={isBusy && !messages.length}>
                  Reset
                </Button>
                <Button asChild variant="outline">
                  <Link to="/">Back to Workflow Demo</Link>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Chat Transcript</CardTitle>
            <CardDescription>
              Assistant text is incrementally updated from `chat:token:*` events.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {orderedMessages.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
                Start by sending a user message.
              </div>
            ) : (
              <div className="space-y-3">
                {orderedMessages.map(message => (
                  <div
                    key={message.id}
                    className={`rounded-lg border p-3 text-sm ${
                      message.role === 'user' ? 'bg-muted/30' : 'bg-background'
                    }`}
                  >
                    <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                      {message.role}
                    </div>
                    <div className="whitespace-pre-wrap">{getMessageText(message.parts)}</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Job Diagnostics</span>
              <Badge variant="outline">{status.toUpperCase()}</Badge>
            </CardTitle>
            <CardDescription>Current chat job status and stream details.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="text-xs font-medium uppercase text-muted-foreground">Job ID</div>
              <div className="mt-1 break-all">{jobId || 'Not started'}</div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="text-xs font-medium uppercase text-muted-foreground">Token Events</div>
              <div className="mt-1">{tokenEvents}</div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3 text-sm sm:col-span-2">
              <div className="text-xs font-medium uppercase text-muted-foreground">Events Stream</div>
              <div className="mt-1">{eventsConnectionStatus}</div>
            </div>
            {error && (
              <div className="rounded-lg border border-destructive p-3 text-sm text-destructive sm:col-span-2">
                {error}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Raw Job Events</CardTitle>
            <CardDescription>Debug view of events received from the IVCAP Job Events API.</CardDescription>
          </CardHeader>
          <CardContent>
            <EventStream events={events} eventsConnectionStatus={eventsConnectionStatus} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
