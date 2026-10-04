"""Synthetic server-originated model/schema/cache smoke. Never prints credentials or output text."""
import json
from pathlib import Path
import time
import urllib.request
import urllib.error
from urllib.parse import urlparse
import re


def main():
    values = dict(line.split("=", 1) for line in Path("/root/.config/avito-partner-ai/qwen.env").read_text().splitlines() if "=" in line)
    host = urlparse(values["QWEN_API_HOST"])
    if host.scheme != "https" or not re.fullmatch(r"[a-z0-9-]+\.ap-southeast-1\.maas\.aliyuncs\.com", host.hostname or ""):
        raise SystemExit("INVALID_QWEN_API_HOST")
    prefix = ("Ты проверяешь доступность API. Ответь по-русски одним JSON объектом с ключом answer. "
              "Утверждённый ориентир участия партнёра: около 3–4 часов в день.\n" * 100)
    results = []
    for run in range(2):
        payload = {"model": "qwen3.8-flash", "stream": False, "enable_thinking": False, "max_tokens": 120,
                   "messages": [{"role": "system", "content": [{"type": "text", "text": prefix,
                                  "cache_control": {"type": "ephemeral"}}]},
                                {"role": "user", "content": "Сколько времени потребуется?"}],
                   "response_format": {"type": "json_schema", "json_schema": {"name": "network_probe", "strict": True,
                                       "schema": {"type": "object", "properties": {"answer": {"type": "string"}},
                                                  "required": ["answer"], "additionalProperties": False}}}}
        if values.get("QWEN_STRUCTURED_OUTPUT", "json_object") == "json_object":
            payload["response_format"] = {"type": "json_object"}
        request = urllib.request.Request(host.geturl().rstrip("/") + "/compatible-mode/v1/chat/completions",
                                         data=json.dumps(payload).encode(), method="POST",
                                         headers={"Content-Type": "application/json", "Authorization": "Bearer " + values["QWEN_API_KEY"]})
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                body = json.load(response)
        except urllib.error.HTTPError as error:
            # No provider body, key, host or response text in stdout.
            try:
                failure = json.loads(error.read().decode("utf-8", errors="replace"))
            except Exception:
                failure = {}
            code = (failure.get("error") or failure).get("code", "UNKNOWN")
            safe_code = code if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", code) else "UNKNOWN"
            print(json.dumps({"ok": False, "run": run + 1, "status": error.code,
                              "error": "QWEN_NETWORK_SMOKE_HTTP_ERROR", "providerErrorCode": safe_code}))
            raise SystemExit(1)
        except Exception:
            print(json.dumps({"ok": False, "error": "QWEN_NETWORK_SMOKE_TRANSPORT_ERROR"}))
            raise SystemExit(1)
        choice = body["choices"][0]
        decoded = json.loads(choice["message"]["content"])
        if body.get("model") != "qwen3.8-flash" or choice["finish_reason"] != "stop" or not isinstance(decoded.get("answer"), str):
            raise SystemExit("QWEN_NETWORK_SMOKE_INVALID_RESPONSE")
        usage = body["usage"]
        details = usage.get("prompt_tokens_details") or {}
        result = {"ok": True, "run": run + 1, "model": body["model"], "structuredOutput": payload["response_format"]["type"], "inputTokensIncludingCache": usage["prompt_tokens"],
                  "outputTokens": usage["completion_tokens"], "cacheReadTokens": details.get("cached_tokens", 0),
                  "cacheCreationTokens": details.get("cache_creation_input_tokens", 0),
                  "latencyMs": round((time.monotonic() - started) * 1000)}
        results.append(result)
        print(json.dumps(result))
    Path("/root/.config/avito-partner-ai/qwen-network-smoke.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
