"""Online, consistent SQLite backup and immutable build/config rollback point."""
import datetime
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile


def main():
    project = Path("/opt/avito-partner-ai")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=project, text=True).strip()
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=project, text=True).strip():
        raise SystemExit("Production checkout is dirty; backup/rollout stopped.")
    if shutil.disk_usage(project).free < 2 * 1024**3:
        raise SystemExit("Insufficient backup disk headroom.")
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup = Path("/opt/avito-partner-ai-backups") / ("qwen-migration-" + timestamp)
    backup.mkdir(mode=0o700, parents=True)
    config = backup / "env.local"
    shutil.copy2(project / ".env.local", config)
    os.chmod(config, 0o600)
    with sqlite3.connect("file:/opt/avito-partner-ai/data/local.db?mode=ro", uri=True) as source:
        with sqlite3.connect(backup / "local.db") as target:
            source.backup(target)
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise SystemExit("Backup integrity check failed.")
    os.chmod(backup / "local.db", 0o600)
    with tarfile.open(backup / "next-build.tar", "w") as archive:
        archive.add((project / ".next").resolve(), arcname=".next")
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=project, text=True).strip() != revision:
        raise SystemExit("Production changed during backup.")
    manifest = {"revision": revision, "createdAt": timestamp, "databaseIntegrity": "ok",
                "rolloutStarted": False, "backup": str(backup)}
    (backup / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
