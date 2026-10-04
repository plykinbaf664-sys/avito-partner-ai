"""Interactive credential entry. No credentials in argv, history, stdout or repository."""
import getpass
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlparse


def main():
    if os.name != "posix" or not os.isatty(0):
        raise SystemExit("Run interactively on the production server with ssh -t.")
    target = Path("/root/.config/avito-partner-ai/qwen.env")
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if target.parent.is_symlink() or target.is_symlink():
        raise SystemExit("Refusing symlink credential path.")
    os.chmod(target.parent, 0o700)
    key = getpass.getpass("QWEN_API_KEY (hidden): ").strip()
    host = getpass.getpass("QWEN_API_HOST (Singapore workspace host, hidden): ").strip()
    parsed = urlparse(host if "://" in host else "https://" + host)
    if (not key or any(c.isspace() for c in key) or parsed.scheme != "https"
            or parsed.username or parsed.password or parsed.port not in (None, 443)
            or not re.fullmatch(r"[a-z0-9-]+\.ap-southeast-1\.maas\.aliyuncs\.com", parsed.hostname or "")
            or parsed.path not in ("", "/", "/compatible-mode/v1", "/compatible-mode/v1/")
            or parsed.query or parsed.fragment):
        raise SystemExit("Invalid key or Singapore workspace host. Values were not saved.")
    content = ("LLM_PROVIDER=qwen\nQWEN_MODEL=qwen3.8-flash\nQWEN_API_KEY=" + key
               + "\nQWEN_API_HOST=https://" + parsed.hostname
               + "\nQWEN_CACHE_MODE=explicit\nQWEN_STRUCTURED_OUTPUT=json_object\nQWEN_TIMEOUT_MS=120000\n"
               + "QWEN_THINKING_MODE=bounded\nQWEN_THINKING_BUDGET=2048\n")
    descriptor, temporary = tempfile.mkstemp(prefix="qwen-", dir=target.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("Candidate credentials saved with mode 0600. Production selection was not changed.")


if __name__ == "__main__":
    main()
