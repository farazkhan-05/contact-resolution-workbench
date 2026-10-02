"""Bootstrap-only diagnostics on the existing server logger; no identity content."""

import json
import logging
import re
import traceback
from collections.abc import Callable, Coroutine, Iterator
from contextlib import contextmanager
from pathlib import Path
from time import perf_counter
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, Request, Response
from fastapi.routing import APIRoute
from sqlalchemy.exc import DBAPIError, SQLAlchemyError
from starlette.responses import JSONResponse

logger = logging.getLogger("uvicorn.error.bootstrap")


class BootstrapDiagnostics:
    def __init__(self) -> None:
        self.request_id = uuid4().hex
        self.started = perf_counter()
        self.failed_phase: str | None = None

    def emit(self, event: str, **fields: str | int | float | bool | None) -> None:
        logger.info(
            json.dumps(
                {
                    "event": event,
                    "request_id": self.request_id,
                    "total_duration_ms": round((perf_counter() - self.started) * 1000, 2),
                    **fields,
                }
            )
        )

    @contextmanager
    def phase(self, name: str) -> Iterator[None]:
        started = perf_counter()
        outcome = "success"
        try:
            yield
        except Exception:
            outcome = "failure"
            if self.failed_phase is None:
                self.failed_phase = name
            raise
        finally:
            self.emit(
                "bootstrap.phase",
                phase=name,
                outcome=outcome,
                phase_duration_ms=round((perf_counter() - started) * 1000, 2),
            )

    def failure(self, exc: Exception) -> None:
        # Never log str(exc), repr(exc), SQL/parameters, locals, or source text.
        # Class chain and code locations retain actionable context without values.
        chain: list[str] = []
        current: BaseException | None = exc
        while current is not None and len(chain) < 8:
            chain.append(type(current).__name__)
            current = current.__cause__ or current.__context__
        frames = [
            f"{Path(frame.filename).name}:{frame.lineno}:{frame.name}"
            for frame in traceback.extract_tb(exc.__traceback__)
        ]
        sqlstate = getattr(getattr(exc, "orig", None), "sqlstate", None)
        self.emit(
            "bootstrap.error",
            phase=self.failed_phase or "request",
            outcome="failure",
            exception_class=type(exc).__name__,
            exception_chain=",".join(chain),
            exception_category=(
                "authentication"
                if isinstance(exc, HTTPException)
                else "database"
                if isinstance(exc, SQLAlchemyError)
                else "server"
            ),
            code_locations=",".join(frames[-12:]),
            sqlstate=sqlstate
            if isinstance(sqlstate, str) and re.fullmatch(r"[A-Z0-9]{5}", sqlstate)
            else None,
            connection_invalidated=isinstance(exc, DBAPIError) and exc.connection_invalidated,
        )


class BootstrapRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def instrumented(request: Request) -> Response:
            diagnostics = BootstrapDiagnostics()
            request.state.bootstrap_diagnostics = diagnostics
            diagnostics.emit("bootstrap.started")
            status_code = 500
            try:
                response = await handler(request)
                status_code = response.status_code
                return response
            except HTTPException as exc:
                status_code = exc.status_code
                diagnostics.failure(exc)
                raise
            except Exception as exc:
                diagnostics.failure(exc)
                return JSONResponse(
                    status_code=500,
                    content={"detail": "The workspace could not be initialized. Please retry."},
                )
            finally:
                diagnostics.emit(
                    "bootstrap.completed",
                    phase="response",
                    status_code=status_code,
                    outcome="success" if status_code < 400 else "failure",
                )

        return instrumented
