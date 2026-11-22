#!/usr/bin/env python3
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys

config = Path("/etc/nginx/sites-available/default")
snippet = Path(sys.argv[1]).read_text(encoding="utf-8")
marker = "    listen [::]:443 ssl ipv6only=on; # managed by Certbot"
current = config.read_text(encoding="utf-8")
if "location = /api/chat/events" in current:
    print("easyPTO chat Nginx locations already exist; leaving config unchanged")
    raise SystemExit(0)
if current.count(marker) != 1 or "server_name faallleenn.asia www.faallleenn.asia;" not in current:
    raise SystemExit("Expected the existing faallleenn.asia TLS server block exactly once; config unchanged")

stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-UTC")
backup = config.with_name(f"default.before-easypto-chat-{stamp}")
backup.write_text(current, encoding="utf-8")
updated = current.replace(marker, snippet + "\n" + marker, 1)
config.write_text(updated, encoding="utf-8")
check = subprocess.run(["nginx", "-t"], text=True, capture_output=True)
if check.returncode != 0:
    config.write_text(current, encoding="utf-8")
    print(check.stdout + check.stderr, file=sys.stderr)
    print(f"Restored {backup.name}", file=sys.stderr)
    raise SystemExit(check.returncode)
reload_result = subprocess.run(["systemctl", "reload", "nginx"], text=True, capture_output=True)
if reload_result.returncode != 0:
    config.write_text(current, encoding="utf-8")
    subprocess.run(["systemctl", "reload", "nginx"], check=False)
    print(reload_result.stdout + reload_result.stderr, file=sys.stderr)
    raise SystemExit(reload_result.returncode)
print(f"Nginx validated and reloaded; backup: {backup}")
