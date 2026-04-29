"""Write cron run status to Cloudflare KV via wrangler CLI."""
import subprocess, json, sys
from datetime import datetime, timezone

KV_NAMESPACE_ID = "ad6cb6f820074d61bb990a9e2fe8875d"
WRANGLER_DIR = r"C:\Users\DELL\bookmark-cli\telegram-bot"

def main():
    status = {
        "last_run": datetime.now(timezone.utc).isoformat(),
        "status": sys.argv[1] if len(sys.argv) > 1 else "complete",
    }

    cmd = (
        f'npx wrangler kv key put --namespace-id {KV_NAMESPACE_ID}'
        f' "__cron_status" {json.dumps(json.dumps(status))}'
    )
    result = subprocess.run(
        cmd,
        cwd=WRANGLER_DIR,
        capture_output=True,
        text=True,
        shell=True,
        encoding="utf-8",
        errors="replace",
    )

    if result.returncode != 0:
        print(f"Failed to write status to KV: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    else:
        print(f"Status written: {status['last_run']} — {status['status']}")

if __name__ == "__main__":
    main()
