from pydantic import BaseModel, Field, ConfigDict
from typing import Optional

from ivcap_service import getLogger, Service, JobContext
from ivcap_ai_tool import start_tool_server, ToolOptions, ivcap_ai_tool, logging_init

from simulator import WorkflowSimulator

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


if __name__ == "__main__":
    start_tool_server(service)
