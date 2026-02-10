from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, Literal

from ivcap_service import getLogger, Service, JobContext
from ivcap_ai_tool import start_tool_server, ToolOptions, ivcap_ai_tool, logging_init

from simulator import WorkflowSimulator
from chat_simulator import ChatSimulator

logging_init()
logger = getLogger("app")


# Service details.
service = Service(
    name="Workflow Simulator",
    contact={
        "name": "Dan Wild",
        "email": "Dan.Wild@data61.csiro.au",
    },
    license={
        "name": "MIT",
        "url": "https://opensource.org/license/MIT",
    },
)


# Specify input value(s).
class Request(BaseModel):
    # A unique schema identifier for this data format.
    jschema: str = Field(
        "urn:sd:schema.workflow-simulator.request.1", alias="$schema")
    # Input values.
    preset_name: str = Field(
        description="Name of the workflow preset to run (e.g., 'deep_research', 'multi_agent_crew', 'simple_pipeline', 'timer_tick')"
    )
    total_run_time_seconds: Optional[float] = Field(
        default=60.0,
        description="Total runtime for timer_tick preset (seconds, max 600)"
    )
    tick_interval_seconds: Optional[float] = Field(
        default=5.0,
        description="Tick interval for timer_tick preset (seconds)"
    )

    # An example showing how to supply the input data.
    model_config = ConfigDict(json_schema_extra={
        "example": {
            "$schema": "urn:sd:schema.workflow-simulator.request.1",
            "preset_name": "deep_research"
        }
    })


# Specify result value(s).
class Result(BaseModel):
    # A unique schema identifier for this data format.
    jschema: str = Field("urn:sd:schema.workflow-simulator.1", alias="$schema")
    # Result values.
    message: str = Field(description="Success message on workflow completion")
    preset_name: str = Field(
        description="Name of the preset that was executed")
    phases_completed: int = Field(description="Number of phases completed")
    agents_executed: int = Field(description="Number of agents that executed")
    total_events: int = Field(description="Total number of events emitted")
    elapsed_seconds: float = Field(
        description="Total execution time in seconds")

    # An example showing what the result will look like.
    model_config = ConfigDict(json_schema_extra={
        "example": {
            "$schema": "urn:sd:schema.workflow-simulator.1",
            "message": "Workflow completed successfully",
            "preset_name": "deep_research",
            "phases_completed": 5,
            "agents_executed": 12,
            "total_events": 48,
            "elapsed_seconds": 45.2
        }
    })


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"] = Field(
        description="Role of this chat message"
    )
    content: str = Field(description="Text content of the message")


class ChatRequest(BaseModel):
    jschema: str = Field(
        "urn:sd:schema.workflow-simulator.chat.request.1", alias="$schema"
    )
    messages: list[ChatMessage] = Field(
        description="Conversation messages to send to the chat model"
    )
    model: str = Field(
        default="gpt-5-mini",
        description="Model name resolved by the LiteLLM proxy",
    )
    temperature: Optional[float] = Field(
        default=None,
        description="Optional sampling temperature for the model request",
    )
    max_tokens: Optional[int] = Field(
        default=None,
        description="Optional upper bound for generated tokens",
    )

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "$schema": "urn:sd:schema.workflow-simulator.chat.request.1",
            "model": "gpt-5-mini",
            "messages": [
                {"role": "system", "content": "You are concise and helpful."},
                {"role": "user", "content": "Summarize the benefits of event streaming in one sentence."}
            ]
        }
    })


class ChatResult(BaseModel):
    jschema: str = Field(
        "urn:sd:schema.workflow-simulator.chat.result.1", alias="$schema"
    )
    message: str = Field(description="Success message on chat completion")
    model: str = Field(description="Model used for completion")
    response_text: str = Field(description="Final response text assembled from streamed chunks")
    chunks_emitted: int = Field(description="Number of streamed chunks emitted as Job Events")
    approx_tokens_emitted: int = Field(description="Approximate token count based on streamed chunk text")
    total_events: int = Field(description="Total number of events emitted by this chat run")
    elapsed_seconds: float = Field(description="Total execution time in seconds")

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "$schema": "urn:sd:schema.workflow-simulator.chat.result.1",
            "message": "Chat completed successfully",
            "model": "gpt-5-mini",
            "response_text": "Event streaming improves responsiveness by delivering partial output immediately.",
            "chunks_emitted": 12,
            "approx_tokens_emitted": 24,
            "total_events": 31,
            "elapsed_seconds": 2.41
        }
    })


# API Functionality.
@ivcap_ai_tool("/", opts=ToolOptions(tags=["Workflow Simulator"]))
def run_workflow_simulation(req: Request, jobCtxt: JobContext) -> Result:
    """
    Runs a workflow simulation based on a preset definition.

    Simulates multi-agent workflows (like CrewAI or ChatGPT Deep Research)
    by emitting IVCAP events at realistic intervals. Useful for frontend
    development and UX testing against realistic event streams.

    Available presets:
    - deep_research: Multi-phase research workflow (Search, Analyze, Synthesize)
    - multi_agent_crew: CrewAI-style with multiple specialized agents
    - simple_pipeline: Basic 3-step sequential workflow for baseline testing
    - timer_tick: Simple timer that emits one event per tick interval
    """
    logger.info(f"Starting workflow simulation with preset: {req.preset_name}")

    # Create simulator with the job context
    simulator = WorkflowSimulator(
        job_context=jobCtxt,
        logger=logger,
    )

    # Run the simulation
    if req.preset_name == "timer_tick":
        if req.total_run_time_seconds <= 0 or req.tick_interval_seconds <= 0:
            raise ValueError(
                "total_run_time_seconds and tick_interval_seconds must be > 0"
            )
        total_run_time_seconds = req.total_run_time_seconds
        if total_run_time_seconds > WorkflowSimulator.MAX_TIMER_SECONDS:
            logger.warning(
                "total_run_time_seconds=%s exceeds max of %ss; capping to max",
                total_run_time_seconds,
                WorkflowSimulator.MAX_TIMER_SECONDS,
            )
            total_run_time_seconds = WorkflowSimulator.MAX_TIMER_SECONDS

        result = simulator.run_timer_tick(
            total_run_time_seconds=total_run_time_seconds,
            tick_interval_seconds=req.tick_interval_seconds,
        )
    else:
        result = simulator.run(req.preset_name)

    logger.info(
        f"Workflow completed: {result.phases_completed} phases, "
        f"{result.agents_executed} agents, {result.total_events} events, "
        f"{result.elapsed_seconds:.1f}s"
    )

    return Result(
        message="Workflow completed successfully",
        preset_name=result.preset_name,
        phases_completed=result.phases_completed,
        agents_executed=result.agents_executed,
        total_events=result.total_events,
        elapsed_seconds=round(result.elapsed_seconds, 2)
    )


@ivcap_ai_tool("/chat", opts=ToolOptions(tags=["Workflow Simulator", "Chatbot"]))
def run_chat_simulation(req: ChatRequest, jobCtxt: JobContext) -> ChatResult:
    """
    Streams a chat completion through LiteLLM and forwards chunks as Job Events.

    Requires backend environment:
    - LITELLM_PROXY: LiteLLM proxy base URL
    - IVCAP_JWT: bearer token used for proxy authentication
    """
    if not req.messages:
        raise ValueError("messages must contain at least one chat message")

    logger.info("Starting chat simulation with model: %s", req.model)
    simulator = ChatSimulator(job_context=jobCtxt, logger=logger)
    result = simulator.run_streaming_chat(
        messages=[m.model_dump() for m in req.messages],
        model=req.model,
        temperature=req.temperature,
        max_tokens=req.max_tokens,
    )

    logger.info(
        "Chat completed: model=%s chunks=%s approx_tokens=%s total_events=%s elapsed=%.2fs",
        result.model,
        result.chunks_emitted,
        result.approx_tokens_emitted,
        result.total_events,
        result.elapsed_seconds,
    )
    return ChatResult(
        message="Chat completed successfully",
        model=result.model,
        response_text=result.response_text,
        chunks_emitted=result.chunks_emitted,
        approx_tokens_emitted=result.approx_tokens_emitted,
        total_events=result.total_events,
        elapsed_seconds=round(result.elapsed_seconds, 2),
    )


if __name__ == "__main__":
    start_tool_server(service)
