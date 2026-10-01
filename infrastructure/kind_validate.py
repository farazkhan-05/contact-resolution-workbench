"""Disposable kind deployment gate. Run through the backend's frozen uv environment."""

import argparse
import hashlib
import json
import os
import platform
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from typing import TextIO

KIND_VERSION = "v0.33.0"
KUBERNETES_VERSION = "v1.37.0"
NODE_IMAGE = (
    "kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5"
)
IMAGE = "contact-resolution-workbench-backend:kind"
ROOT = Path(__file__).resolve().parents[1]
CLUSTER = "crw-e1"


def drain_output(stream: TextIO) -> None:
    """Keep kubectl connection messages from filling its stdout pipe."""
    for _ in stream:
        pass


def install_tools(directory: Path) -> None:
    system = platform.system().lower()
    arch = {"x86_64": "amd64", "AMD64": "amd64", "aarch64": "arm64"}.get(platform.machine())
    if system not in {"linux", "windows", "darwin"} or arch is None:
        raise RuntimeError("Unsupported official binary platform")
    suffix = ".exe" if system == "windows" else ""
    urls = {
        "kind": f"https://github.com/kubernetes-sigs/kind/releases/download/{KIND_VERSION}/kind-{system}-{arch}",
        "kubectl": f"https://dl.k8s.io/release/{KUBERNETES_VERSION}/bin/{system}/{arch}/kubectl{suffix}",
    }
    directory.mkdir(parents=True, exist_ok=True)
    for name, url in urls.items():
        # Official kind assets omit .exe in the download name, including Windows.
        binary = urllib.request.urlopen(url, timeout=120).read()
        checksum = (
            urllib.request.urlopen(
                url + ".sha256sum" if name == "kind" else url + ".sha256", timeout=30
            )
            .read()
            .decode()
            .split()[0]
        )
        if hashlib.sha256(binary).hexdigest() != checksum:
            raise RuntimeError(f"Official {name} checksum mismatch")
        target = directory / (name + suffix)
        target.write_bytes(binary)
        target.chmod(0o755)
        print(f"Verified {name} official SHA256", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tools", type=Path)
    parser.add_argument("--diagnostics", type=Path)
    args = parser.parse_args()
    sensitive = [secrets.token_hex(24), secrets.token_hex(24)]
    forwards: list[subprocess.Popen[str]] = []
    with tempfile.TemporaryDirectory(prefix="crw-kind-") as temporary:
        scratch = Path(temporary)
        tools = args.tools or scratch / "tools"
        install_tools(tools)
        env = os.environ.copy()
        env["PYTHONUTF8"] = "1"
        env["PATH"] = str(tools.resolve()) + os.pathsep + env["PATH"]
        env["KUBECONFIG"] = str(scratch / "kubeconfig")

        def run(*command: str, data: str | None = None, check: bool = True) -> str:
            result = subprocess.run(
                command,
                input=data,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                cwd=ROOT,
                timeout=900,
                check=False,
                executable=shutil.which(command[0], path=env["PATH"]),
            )
            output = result.stdout + result.stderr
            for value in sensitive:
                output = output.replace(value, "[redacted]")
            if check and result.returncode:
                raise RuntimeError(f"{command[0]} failed ({result.returncode}):\n{output}")
            return output if not check else result.stdout

        def apply(items: list[dict[str, object]]) -> None:
            run(
                "kubectl",
                "apply",
                "-f",
                "-",
                data=json.dumps({"apiVersion": "v1", "kind": "List", "items": items}),
            )

        if KIND_VERSION not in run("kind", "version"):
            raise RuntimeError("Unexpected kind version")
        if CLUSTER in run("kind", "get", "clusters").split():
            raise RuntimeError(f"Refusing to replace existing cluster {CLUSTER}")
        # Enables the workflow's always() fallback if its run step is cancelled.
        (tools / "owns-cluster").write_text(CLUSTER)
        try:
            rendered = run("kubectl", "kustomize", "infrastructure/k8s/kind")
            if not rendered.strip():
                raise RuntimeError("Empty Kustomize render")
            print("Kustomize render passed; creating fresh cluster", flush=True)
            run(
                "kind",
                "create",
                "cluster",
                "--name",
                CLUSTER,
                "--image",
                NODE_IMAGE,
                "--wait",
                "180s",
            )
            objects = json.loads(
                run(
                    "kubectl",
                    "apply",
                    "--dry-run=client",
                    "-f",
                    "-",
                    "-o",
                    "json",
                    data=rendered,
                )
            )["items"]
            print("Client dry-run passed; building shared backend image", flush=True)
            run("docker", "build", "-t", IMAGE, "backend")
            identity = run("docker", "run", "--rm", IMAGE, "id")
            if "uid=999(app)" not in identity or "gid=999(app)" not in identity:
                raise RuntimeError(f"Backend image identity changed: {identity}")
            run("kind", "load", "docker-image", IMAGE, "--name", CLUSTER)
            print("Shared image built, non-root identity verified, image loaded", flush=True)

            def secret(name: str, values: dict[str, str]) -> dict[str, object]:
                return {
                    "apiVersion": "v1",
                    "kind": "Secret",
                    "metadata": {"name": name},
                    "type": "Opaque",
                    "stringData": values,
                }

            apply(
                [
                    secret("postgres-secrets", {"POSTGRES_PASSWORD": sensitive[0]}),
                    secret(
                        "backend-secrets",
                        {
                            "DATABASE_URL": f"postgresql://workbench:{sensitive[0]}@postgres:5432/workbench",
                            "KIND_TEST_TOKEN": sensitive[1],
                        },
                    ),
                    {
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "metadata": {"name": "kind-test-auth"},
                        "data": {"kind_api.py": (ROOT / "backend/tests/kind_api.py").read_text()},
                    },
                ]
            )
            workloads = [
                item
                for item in objects
                if item["kind"] == "Deployment" and item["metadata"]["name"] in {"api", "worker"}
            ]
            migration = [item for item in objects if item["kind"] == "Job"]
            apply([item for item in objects if item not in workloads + migration])
            for name in ("redis", "postgres"):
                run(
                    "kubectl",
                    "rollout",
                    "status",
                    f"deployment/{name}",
                    "--timeout=180s",
                )
            print("Disposable Redis and PostgreSQL ready", flush=True)
            apply(migration)
            run(
                "kubectl",
                "wait",
                "--for=condition=complete",
                "job/migrate",
                "--timeout=180s",
            )
            print("Migration Job passed; starting API and worker", flush=True)
            apply(workloads)
            for name in ("api", "worker"):
                run(
                    "kubectl",
                    "rollout",
                    "status",
                    f"deployment/{name}",
                    "--timeout=180s",
                )
            # Deployment availability alone cannot establish Celery readiness.
            for attempt in range(30):
                ping = run(
                    "kubectl",
                    "exec",
                    "deployment/worker",
                    "--",
                    "celery",
                    "-A",
                    "app.celery_app:celery_app",
                    "inspect",
                    "ping",
                    "--timeout=2",
                    check=False,
                )
                if "pong" in ping:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Celery worker did not answer broker ping")

            ports: dict[str, int] = {}
            for name, remote in (("api", 8000), ("redis", 6379), ("postgres", 5432)):
                process = subprocess.Popen(
                    [
                        "kubectl",
                        "port-forward",
                        "--address",
                        "127.0.0.1",
                        f"service/{name}",
                        f":{remote}",
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    env=env,
                    executable=shutil.which("kubectl", path=env["PATH"]),
                )
                forwards.append(process)
                # kubectl assigns an available local port; avoids collisions with Compose.
                assert process.stdout is not None
                line = process.stdout.readline()
                if not line.startswith("Forwarding from 127.0.0.1:"):
                    raise RuntimeError(f"Port-forward failed: {line}")
                ports[name] = int(line.split(":")[1].split()[0])
                threading.Thread(target=drain_output, args=(process.stdout,), daemon=True).start()
            api_url = f"http://127.0.0.1:{ports['api']}"
            with urllib.request.urlopen(api_url + "/api/health", timeout=10) as response:
                assert json.load(response) == {"status": "ok"}
            print("API health and Celery broker ping passed; running async smoke", flush=True)
            env.update(
                DATABASE_URL=f"postgresql://workbench:{sensitive[0]}@127.0.0.1:{ports['postgres']}/workbench",
                CELERY_BROKER_URL=f"redis://127.0.0.1:{ports['redis']}/0",
                RUN_ASYNC_INTEGRATION="1",
                ASYNC_API_URL=api_url,
                KIND_TEST_TOKEN=sensitive[1],
                OBSERVABILITY_ENABLED="false",
                GEMINI_API_KEY="",
                FIREBASE_SERVICE_ACCOUNT_JSON="",
                LANGFUSE_SECRET_KEY="",
                LANGFUSE_PUBLIC_KEY="",
            )
            # Tests run in the existing backend environment. No second image or unit suite.
            try:
                tested = subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "pytest",
                        "tests/test_async_integration.py",
                        "tests/test_investigation_integration.py",
                        "-k",
                        "not celery_postgres_resume_obtains_mcp",
                        "-vv",
                        "-o",
                        "faulthandler_timeout=30",
                    ],
                    cwd=ROOT / "backend",
                    env=env,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=180,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                output = (exc.stdout or b"") + (exc.stderr or b"")
                report = output.decode("utf-8", errors="replace")
                for value in sensitive:
                    report = report.replace(value, "[redacted]")
                print(report, flush=True)
                raise
            result = tested.stdout + tested.stderr
            for value in sensitive:
                result = result.replace(value, "[redacted]")
            print(result, flush=True)
            if tested.returncode:
                raise RuntimeError("Async integration smoke failed")
            print(
                "API health, HTTP submission, durable CSV Job and D1 investigation passed",
                flush=True,
            )
        except BaseException:
            diagnostics = []
            for command in (
                ("get", "pods", "-o", "wide"),
                ("get", "events", "--sort-by=.lastTimestamp"),
                ("describe", "deployments"),
                ("describe", "job/migrate"),
            ):
                diagnostics.append(run("kubectl", *command, check=False))
            for name in ("api", "worker", "redis", "postgres"):
                diagnostics.append(
                    run(
                        "kubectl",
                        "logs",
                        f"deployment/{name}",
                        "--all-containers",
                        "--tail=100",
                        check=False,
                    )
                )
            diagnostics.append(run("kubectl", "logs", "job/migrate", "--tail=100", check=False))
            report = "\n".join(diagnostics)
            print(report, flush=True)
            if args.diagnostics:
                args.diagnostics.mkdir(parents=True, exist_ok=True)
                (args.diagnostics / "diagnostics.log").write_text(report)
            raise
        finally:
            try:
                for process in forwards:
                    try:
                        process.terminate()
                        process.wait(timeout=10)
                    except (OSError, subprocess.TimeoutExpired):
                        process.kill()
            finally:
                run("kind", "delete", "cluster", "--name", CLUSTER)
                if CLUSTER in run("kind", "get", "clusters").split():
                    raise RuntimeError("Ephemeral cluster cleanup failed")
                (tools / "owns-cluster").unlink(missing_ok=True)
                print("Ephemeral kind cluster deleted", flush=True)


if __name__ == "__main__":
    main()
