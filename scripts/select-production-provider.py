"""Atomically select a provider without printing credentials or changing networking.

Run on the production server after the release gates. This does not restart services.
Rollback: python3 scripts/select-production-provider.py anthropic
"""
import argparse
import os
from pathlib import Path
import re
import tempfile


def read_values(path):
    values = {}
    for line in path.read_text().splitlines():
        match = re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line)
        if match:
            values[match[1]] = match[2]
    return values


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("provider", choices=["qwen", "anthropic"])
    args = parser.parse_args()
    project = Path("/opt/avito-partner-ai")
    path = project / ".env.local"
    current = read_values(path)
    replacement = {"LLM_PROVIDER": args.provider}
    if args.provider == "qwen":
        candidate = Path("/root/.config/avito-partner-ai/qwen.env")
        if candidate.stat().st_mode & 0o077:
            raise SystemExit("Credential file must be private.")
        values = read_values(candidate)
        keys = ["QWEN_API_KEY", "QWEN_API_HOST", "QWEN_MODEL", "QWEN_CACHE_MODE",
                "QWEN_STRUCTURED_OUTPUT", "QWEN_TIMEOUT_MS"]
        if not all(values.get(key) for key in keys):
            raise SystemExit("Qwen candidate configuration incomplete.")
        replacement.update({key: values[key] for key in keys})
        replacement.update({key: values.get(key, default) for key, default in
                            [("QWEN_THINKING_MODE", "off"), ("QWEN_THINKING_BUDGET", "1024")]})
    elif not current.get("ANTHROPIC_API_KEY") or not current.get("ANTHROPIC_MODEL"):
        raise SystemExit("Anthropic rollback configuration incomplete.")
    lines = [line for line in path.read_text().splitlines()
             if not any(re.match(r"^" + key + r"\s*=", line) for key in replacement)]
    content = "\n".join(lines + [key + "=" + value for key, value in replacement.items()]) + "\n"
    descriptor, temporary = tempfile.mkstemp(prefix=".provider-env-", dir=project)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("SELECTED_PROVIDER=" + args.provider + " (restart required)")


if __name__ == "__main__":
    main()
