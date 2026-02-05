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
    tasks: list[str] = Field(description="List of task status messages to emit")
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
    description: str = Field(description="Description of what this workflow simulates")
    phases: list[PhaseConfig] = Field(description="Ordered list of workflow phases")


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
    
    def _emit_event(self, step_id: str, message: str, finished: bool = False) -> None:
        """Emit an IVCAP event."""
        self._event_count += 1
        action = "step_finished" if finished else "step_started"
        self.logger.info(
            "Emitting %s for %s: %s",
            action,
            step_id,
            message,
        )
        if finished:
            self.job_context.report.step_finished(step_id, message)
        else:
            self.job_context.report.step_started(step_id, message)
    
    def _execute_agent(self, phase_id: str, agent: AgentConfig) -> None:
        """Execute a single agent's tasks within a phase."""
        agent_step_id = f"agent:{phase_id}:{agent.id}"
        
        # Agent started
        self._emit_event(agent_step_id, f"{agent.name} started")
        
        # Execute each task
        for i, task in enumerate(agent.tasks):
            self._random_delay(agent.delay_range_ms)
            status_step_id = f"{agent_step_id}:task-{i+1}"
            self._emit_event(status_step_id, task)
            self._emit_event(status_step_id, task, finished=True)
        
        # Agent completed
        self._random_delay(agent.delay_range_ms)
        self._emit_event(agent_step_id, f"{agent.name} completed", finished=True)
        self._agents_executed += 1
    
    def _execute_phase(self, phase: PhaseConfig) -> None:
        """Execute a single workflow phase and all its agents."""
        phase_step_id = f"phase:{phase.id}"
        
        # Phase started
        self._emit_event(phase_step_id, f"{phase.name} started")
        self._random_delay(phase.delay_range_ms)
        
        # Execute all agents in the phase
        for agent in phase.agents:
            self._execute_agent(phase.id, agent)
        
        # Phase completed
        self._random_delay(phase.delay_range_ms)
        self._emit_event(phase_step_id, f"{phase.name} completed", finished=True)
    
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
        
        # Emit workflow start
        workflow_step_id = f"workflow:{preset.name}"
        self._emit_event(workflow_step_id, f"Starting workflow: {preset.description}")
        
        # Execute all phases in order
        for phase in preset.phases:
            self._execute_phase(phase)
        
        # Emit workflow completion
        elapsed = time.time() - start_time
        self._emit_event(
            workflow_step_id,
            f"Workflow completed in {elapsed:.1f}s",
            finished=True
        )
        
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

        Emits one event per tick interval using step_started only.
        """
        start_time = time.time()
        self._event_count = 0
        self._agents_executed = 0

        end_time = start_time + total_run_time_seconds
        tick_index = 0

        while time.time() < end_time:
            tick_index += 1
            step_id = f"timer:tick:{tick_index}"
            self._emit_event(step_id, f"Tick {tick_index}")

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
