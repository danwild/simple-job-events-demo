"""
Chat simulator utilities for streaming LiteLLM responses as Job Events.
"""

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, Future
from dataclasses import dataclass

import httpx
from ivcap_service import JobContext, getLogger


class ChatSimulationError(Exception):
    """Structured chat simulation error with stable code/message."""

    def __init__(self, code: str, public_message: str):
        self.code = code
        self.public_message = public_message
        super().__init__(f"{code}: {public_message}")


@dataclass
class ChatSimulationResult:
    """Result payload for a streamed chat run."""
    model: str
    response_text: str
    chunks_emitted: int
    approx_tokens_emitted: int
    total_events: int
    elapsed_seconds: float


class ChatSimulator:
    DEFAULT_LITELLM_PROXY = "https://mindweaver.develop.ivcap.io/litellm"

    """
    Streams an LLM response from LiteLLM and emits token/chunk events through JobContext.
    """

    def __init__(self, job_context: JobContext, logger=None):
        self.job_context = job_context
        self.logger = logger or getLogger("chat-simulator")
        self._event_count = 0

    @staticmethod
    def _proxy_url() -> str:
        proxy = os.getenv("LITELLM_PROXY", "").strip() or ChatSimulator.DEFAULT_LITELLM_PROXY
        return proxy.rstrip("/")

    def _proxy_bearer_token(self) -> str:
        # Prefer explicit env var for local runs.
        token = os.getenv("IVCAP_JWT", "").strip()
        if token:
            self.logger.info("Using LiteLLM auth token source: IVCAP_JWT env var")
            return token

        # Fall back to runtime-provided job authorization on deployed runs.
        job_auth = (self.job_context.job_authorization or "").strip()
        if job_auth:
            self.logger.info("Using LiteLLM auth token source: JobContext.job_authorization")
            lower = job_auth.lower()
            if lower.startswith("bearer "):
                return job_auth[7:].strip()
            return job_auth

        self.logger.error(
            "No LiteLLM auth token source available: missing IVCAP_JWT and JobContext.job_authorization"
        )
        raise ValueError(
            "No bearer token available for LiteLLM proxy auth. "
            "Set IVCAP_JWT (local) or ensure job authorization is available (deployed)."
        )

    @staticmethod
    def _extract_delta_content(payload: dict) -> str:
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices:
            return ""

        delta = choices[0].get("delta", {})
        content = delta.get("content")
        if isinstance(content, str):
            return content

        # Some providers may send structured segments; keep text fragments.
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            return "".join(parts)

        return ""

    def _emit_error_event(self, message: str) -> None:
        """Best-effort error event emission for easier remote diagnosis."""
        if not self.job_context.report:
            return
        safe_message = (message or "").strip()
        if len(safe_message) > 1000:
            safe_message = safe_message[:1000] + "...<truncated>"
        with self.job_context.report.step("chat:error", message=safe_message):
            self._event_count += 2

    # -- Token batching configuration ------------------------------------------
    # Tokens from the LLM stream are accumulated and flushed as a single Job
    # Event when either threshold is exceeded.  This dramatically reduces the
    # number of events emitted (and therefore the end-to-end latency perceived
    # by the client) while the client-side typewriter animation smooths out the
    # visual presentation.
    BATCH_FLUSH_INTERVAL_S = 0.3   # flush at most every 300 ms
    BATCH_FLUSH_MAX_TOKENS = 20    # or when 20 chunks have accumulated

    def run_streaming_chat(
        self,
        messages: list[dict],
        model: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> ChatSimulationResult:
        start = time.time()
        self._event_count = 0
        chunks_emitted = 0
        approx_tokens_emitted = 0
        response_chunks: list[str] = []

        # -- Batch state -------------------------------------------------------
        batch_buffer: list[str] = []
        batch_num = 0
        last_flush = time.monotonic()

        # Background thread for non-blocking event writes.  A single worker
        # preserves event ordering while letting the LLM stream loop continue
        # without waiting for the sidecar HTTP round-trip.
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="event-flush")
        pending_futures: list[Future] = []

        def flush_batch() -> None:
            """Submit a background Job Event write for all buffered token text."""
            nonlocal batch_num, last_flush
            if not batch_buffer:
                return
            batch_num += 1
            text = "".join(batch_buffer)
            batch_buffer.clear()
            last_flush = time.monotonic()
            step_name = f"chat:tokens:{batch_num}"

            def _emit() -> None:
                with self.job_context.report.step(step_name, message=text):
                    pass  # start + finish emitted by context manager

            pending_futures.append(executor.submit(_emit))
            self._event_count += 2  # start + finish

        def drain_pending() -> None:
            """Wait for all background event writes to complete."""
            for fut in pending_futures:
                try:
                    fut.result(timeout=30)
                except Exception as exc:
                    self.logger.warning("Background event write failed: %s", exc)
            pending_futures.clear()

        try:
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._proxy_bearer_token()}",
            }

            payload: dict = {
                "model": model,
                "messages": messages,
                "stream": True,
            }
            if temperature is not None:
                payload["temperature"] = temperature
            if max_tokens is not None:
                payload["max_tokens"] = max_tokens

            endpoint = f"{self._proxy_url()}/v1/chat/completions"
            self.logger.info("Submitting streaming chat request to %s", endpoint)

            with self.job_context.report.step(
                "chat:request", message=f"Submitting chat request to model '{model}'"
            ) as request_step:
                self._event_count += 1

                with httpx.Client(timeout=httpx.Timeout(connect=30.0, read=300.0, write=30.0, pool=30.0)) as client:
                    with client.stream("POST", endpoint, headers=headers, json=payload) as response:
                        if response.is_error:
                            # Capture upstream LiteLLM body + call id to make 4xx/5xx debugging actionable.
                            error_body = ""
                            try:
                                error_body = response.read().decode("utf-8", errors="replace")
                            except Exception:
                                error_body = "<unavailable>"
                            error_body = (error_body or "").strip()
                            if len(error_body) > 1000:
                                error_body = error_body[:1000] + "...<truncated>"
                            call_id = (response.headers.get("x-litellm-call-id") or "").strip()
                            call_id_msg = f", call_id={call_id}" if call_id else ""
                            raise ChatSimulationError(
                                "CHAT_LITELLM_HTTP_ERROR",
                                f"LiteLLM proxy request failed ({response.status_code}{call_id_msg}): "
                                f"{error_body or '<empty body>'}",
                            )

                        request_step.finished("Chat request accepted by LiteLLM proxy")
                        self._event_count += 1

                        with self.job_context.report.step(
                            "chat:response", message="Streaming model response"
                        ) as response_step:
                            self._event_count += 1

                            for raw_line in response.iter_lines():
                                if not raw_line:
                                    continue
                                line = raw_line.strip()
                                if not line.startswith("data:"):
                                    continue

                                data = line[len("data:"):].strip()
                                if data == "[DONE]":
                                    break

                                try:
                                    parsed = json.loads(data)
                                except json.JSONDecodeError:
                                    self.logger.warning("Skipping non-JSON stream chunk: %s", data[:120])
                                    continue

                                delta = self._extract_delta_content(parsed)
                                if not delta:
                                    continue

                                chunks_emitted += 1
                                approx_tokens_emitted += max(1, len(delta.split()))
                                response_chunks.append(delta)

                                # Buffer the token and flush when thresholds are met
                                batch_buffer.append(delta)
                                if (
                                    len(batch_buffer) >= self.BATCH_FLUSH_MAX_TOKENS
                                    or time.monotonic() - last_flush >= self.BATCH_FLUSH_INTERVAL_S
                                ):
                                    flush_batch()

                            # Flush any remaining buffered tokens
                            flush_batch()

                            # Wait for all background event writes before
                            # closing the response step.
                            drain_pending()

                            response_step.finished(f"Completed streaming {chunks_emitted} chunks")
                            self._event_count += 1

            with self.job_context.report.step("chat:complete", message="Chat response finalized"):
                self._event_count += 2

            response_text = "".join(response_chunks).strip()
            elapsed = time.time() - start
            return ChatSimulationResult(
                model=model,
                response_text=response_text,
                chunks_emitted=chunks_emitted,
                approx_tokens_emitted=approx_tokens_emitted,
                total_events=self._event_count,
                elapsed_seconds=elapsed,
            )
        except ChatSimulationError as e:
            self.logger.exception("Chat simulation failed [%s]: %s", e.code, e.public_message)
            self._emit_error_event(f"{e.code}: {e.public_message}")
            raise
        except httpx.TimeoutException as e:
            wrapped = ChatSimulationError("CHAT_LITELLM_TIMEOUT", str(e))
            self.logger.exception("Chat simulation timed out")
            self._emit_error_event(str(wrapped))
            raise wrapped from e
        except Exception as e:  # pylint: disable=broad-exception-caught
            wrapped = ChatSimulationError("CHAT_UNEXPECTED_ERROR", str(e))
            self.logger.exception("Unexpected chat simulation error")
            self._emit_error_event(str(wrapped))
            raise wrapped from e
        finally:
            executor.shutdown(wait=False)
