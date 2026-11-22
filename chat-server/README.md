# easyPTO chat service

The Axum API is deployed as a separate ARM64 Linux service. It stores chat accounts, sessions and messages in a dedicated SQLite database at `/var/lib/easypto-chat/chat.sqlite3`; it never reads the desktop project's local databases. The service binds only to `127.0.0.1:8765`, and Nginx provides the existing HTTPS endpoint at `/api/chat`.

## Runtime

- `POST /api/chat/auth/login` verifies Argon2 password hashes and returns an opaque 30-day session token.
- `GET /api/chat/auth/me`, `POST /api/chat/auth/logout`, `GET /api/chat/messages`, `POST /api/chat/messages`, and `POST /api/chat/read` are session protected.
- `POST /api/chat/ws-ticket` issues a one-time 60-second WebSocket ticket. The exact `/api/chat/events` Nginx location disables access logging so that ticket query strings are not recorded.
- Text messages are limited to 4,000 Unicode characters. `clientMessageId` makes a retried send idempotent.
- SQLite runs in WAL mode. The daily systemd timer creates an integrity-checked backup and keeps the last 30 days.

## Provisioning

Build on the target Linux ARM64 VM with stable Rust, create `/var/lib/easypto-chat` owned by the `easypto-chat` service account, and pass exactly two users as JSON on standard input to:

```sh
sudo -u easypto-chat /usr/local/bin/easypto-chat-server bootstrap-users
```

The bootstrap command hashes passwords with Argon2id, refuses to run if any account already exists, and never writes or logs the plaintext password. Keep the user-supplied credential file outside the repository and restrict its filesystem permissions.

## Configuration

`/etc/easypto-chat.conf` sets `EASY_PTO_CHAT_DB=/var/lib/easypto-chat/chat.sqlite3` and `EASY_PTO_CHAT_BIND=127.0.0.1:8765`. The systemd unit applies filesystem and privilege restrictions. Back up the database before changing schema or replacing the server binary.
