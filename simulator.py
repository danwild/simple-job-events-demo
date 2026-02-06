"""
Workflow Simulator Engine

Loads preset workflow definitions and executes them, emitting IVCAP events
with randomized timing to simulate multi-agent workflows.
"""

import json
import random
import time
from pathlib import Path
from dataclasses import dataclass

from pydantic import BaseModel, Field
from ivcap_service import JobContext, getLogger


class AgentConfig(BaseModel):
    """Configuration for a single agent within a phase."""
    id: str = Field(description="Unique identifier for the agent")
    name: str = Field(description="Display name of the agent")
    tasks: list[str] = Field(
        description="List of task status messages to emit")
    delay_range_ms: list[int] = Field(
        default=[1000, 3000],
        description="Min/max delay in ms between task updates"
    )


class PhaseConfig(BaseModel):
    """Configuration for a workflow phase."""
    id: str = Field(description="Unique identifier for the phase")
    name: str = Field(description="Display name of the phase")
    delay_range_ms: list[int] = Field(
        default=[500, 2000],
        description="Min/max delay in ms for phase transitions"
    )
    agents: list[AgentConfig] = Field(
        default_factory=list,
        description="Agents that execute within this phase"
    )


class WorkflowPreset(BaseModel):
    """Complete workflow preset definition."""
    name: str = Field(description="Name of the workflow preset")
    description: str = Field(
        description="Description of what this workflow simulates")
    phases: list[PhaseConfig] = Field(
        description="Ordered list of workflow phases")


@dataclass
class SimulationResult:
    """Result of running a workflow simulation."""
    preset_name: str
    phases_completed: int
    agents_executed: int
    total_events: int
    elapsed_seconds: float


class WorkflowSimulator:
    """
    Executes workflow simulations based on preset definitions,
    emitting IVCAP events with realistic timing.
    """

    MAX_TIMER_SECONDS = 600
    PRESETS_DIR = Path(__file__).parent / "presets"

    def __init__(
        self,
        job_context: JobContext,
        logger=None,
    ):
        """
        Initialize the simulator.

        Args:
            job_context: IVCAP JobContext for emitting events
        """
        self.job_context = job_context
        self._event_count = 0
        self._agents_executed = 0
        self.logger = logger or getLogger("simulator")

    def load_preset(self, preset_name: str) -> WorkflowPreset:
        """
        Load a workflow preset from the presets directory.

        Args:
            preset_name: Name of the preset (without .json extension)

        Returns:
            WorkflowPreset configuration

        Raises:
            FileNotFoundError: If preset doesn't exist
            ValueError: If preset is invalid
        """
        preset_path = self.PRESETS_DIR / f"{preset_name}.json"

        if not preset_path.exists():
            available = [p.stem for p in self.PRESETS_DIR.glob("*.json")]
            raise FileNotFoundError(
                f"Preset '{preset_name}' not found. Available presets: {available}"
            )

        with open(preset_path) as f:
            data = json.load(f)

        return WorkflowPreset(**data)

    def list_presets(self) -> list[str]:
        """Return list of available preset names."""
        if not self.PRESETS_DIR.exists():
            return []
        return [p.stem for p in self.PRESETS_DIR.glob("*.json")]

    def _random_delay(self, delay_range_ms: list[int]) -> None:
        """Sleep for a random duration within the given range."""
        min_ms, max_ms = delay_range_ms
        delay_ms = random.randint(min_ms, max_ms)
        time.sleep(delay_ms / 1000.0)

    def _execute_agent(self, phase_id: str, agent: AgentConfig) -> None:
        """Execute a single agent's tasks within a phase."""
        agent_step_id = f"agent:{phase_id}:{agent.id}"

        self.logger.info("Starting agent %s: %s", agent_step_id, agent.name)
        with self.job_context.report.step(agent_step_id, message=f"{agent.name} started") as agent_step:
            self._event_count += 1

            # Execute each task
            for i, task in enumerate(agent.tasks):
                self._random_delay(agent.delay_range_ms)
                status_step_id = f"{agent_step_id}:task-{i+1}"
                self.logger.info("Task %s: %s", status_step_id, task)
                with self.job_context.report.step(status_step_id, message=task):
                    self._event_count += 2  # start + finish

            # Agent completed
            self._random_delay(agent.delay_range_ms)
            agent_step.finished(f"{agent.name} completed")
            self._event_count += 1
        self._agents_executed += 1

    def _execute_phase(self, phase: PhaseConfig) -> None:
        """Execute a single workflow phase and all its agents."""
        phase_step_id = f"phase:{phase.id}"

        self.logger.info("Starting phase %s: %s", phase_step_id, phase.name)
        with self.job_context.report.step(phase_step_id, message=f"{phase.name} started") as phase_step:
            self._event_count += 1
            self._random_delay(phase.delay_range_ms)

            # Execute all agents in the phase
            for agent in phase.agents:
                self._execute_agent(phase.id, agent)

            # Phase completed
            self._random_delay(phase.delay_range_ms)
            phase_step.finished(f"{phase.name} completed")
            self._event_count += 1

    def run(self, preset_name: str) -> SimulationResult:
        """
        Run a complete workflow simulation.

        Args:
            preset_name: Name of the preset to run

        Returns:
            SimulationResult with execution statistics
        """
        start_time = time.time()
        self._event_count = 0
        self._agents_executed = 0

        # Load and validate preset
        preset = self.load_preset(preset_name)

        # Run entire workflow inside a top-level step
        workflow_step_id = f"workflow:{preset.name}"
        self.logger.info("Starting workflow: %s", preset.description)
        with self.job_context.report.step(workflow_step_id, message=f"Starting workflow: {preset.description}") as workflow_step:
            self._event_count += 1

            # Execute all phases in order
            for phase in preset.phases:
                self._execute_phase(phase)

            # Emit workflow completion
            elapsed = time.time() - start_time
            workflow_step.finished(f"Workflow completed in {elapsed:.1f}s")
            self._event_count += 1

        return SimulationResult(
            preset_name=preset.name,
            phases_completed=len(preset.phases),
            agents_executed=self._agents_executed,
            total_events=self._event_count,
            elapsed_seconds=elapsed
        )

    def run_timer_tick(
        self,
        total_run_time_seconds: float,
        tick_interval_seconds: float,
    ) -> SimulationResult:
        """
        Run a simple timer/tick simulation for a fixed duration.

        Emits one event per tick interval using the step context manager.
        """
        start_time = time.time()
        self._event_count = 0
        self._agents_executed = 0

        end_time = start_time + total_run_time_seconds
        tick_index = 0

        while time.time() < end_time:
            tick_index += 1
            step_id = f"timer:tick:{tick_index}"
            self.logger.info("Tick %d", tick_index)
            with self.job_context.report.step(step_id, message=f"Tick {tick_index}"):
                self._event_count += 2  # start + finish

            remaining = end_time - time.time()
            if remaining <= 0:
                break
            time.sleep(min(tick_interval_seconds, remaining))

        elapsed = time.time() - start_time
        return SimulationResult(
            preset_name="timer_tick",
            phases_completed=0,
            agents_executed=0,
            total_events=self._event_count,
            elapsed_seconds=elapsed,
        )
