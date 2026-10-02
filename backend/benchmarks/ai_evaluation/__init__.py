"""Local synthetic evaluation only; never imported by application request handling."""

import os

# Set before importing DeepEval: no analytics, persisted login, dotenv, or cloud traces.
os.environ["DEEPEVAL_TELEMETRY_OPT_OUT"] = "1"
os.environ["DEEPEVAL_DISABLE_DOTENV"] = "1"
os.environ["DEEPEVAL_DISABLE_LEGACY_KEYFILE"] = "1"
os.environ["DEEPEVAL_UPDATE_WARNING_OPT_IN"] = "0"
os.environ["CONFIDENT_TRACE_SAMPLE_RATE"] = "0"
os.environ["CONFIDENT_TRACE_FLUSH"] = "0"
os.environ.pop("CONFIDENT_API_KEY", None)
