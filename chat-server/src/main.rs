use std::{collections::HashMap, env, net::SocketAddr, sync::{Arc, Mutex}, time::{Duration, Instant}};

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::{SaltString, rand_core::OsRng}};
use axum::{
    Router,
    extract::{Query, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json,
};
use chrono::{Duration as ChronoDuration, Utc};
use rand_core::RngCore;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use tower_http::cors::{AllowOrigin, CorsLayer};

const SESSION_DAYS: i64 = 30;
const MAX_MESSAGE_CHARS: usize = 4000;

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    events: broadcast::Sender<MessageEvent>,
    ws_tickets: Arc<Mutex<HashMap<String, (i64, chrono::DateTime<Utc>)>>>,
    login_attempts: Arc<Mutex<HashMap<String, Vec<Instant>>>>,
}

#[derive(Debug, Serialize)]
struct ApiErrorBody { error: String }

struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(ApiErrorBody { error: self.1 })).into_response()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct User { id: i64, username: String, display_name: String }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage { id: i64, sender_id: i64, sender_name: String, body: String, sent_at: String }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageEvent { message_id: i64 }

#[derive(Deserialize)]
struct LoginRequest { username: String, password: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse { token: String, user: User, unread_count: i64 }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageRequest { body: String, client_message_id: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadRequest { last_read_message_id: i64 }

#[derive(Deserialize)]
struct HistoryQuery { before: Option<i64>, limit: Option<i64> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryResponse { messages: Vec<ChatMessage>, has_more: bool }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse { user: User, unread_count: i64 }

#[derive(Serialize)]
struct TicketResponse { ticket: String }

#[derive(Deserialize)]
struct TicketQuery { ticket: String }

#[derive(Deserialize)]
struct BootstrapUser { username: String, display_name: String, password: String }

fn sql_error(error: rusqlite::Error) -> ApiError {
    eprintln!("chat database error: {error}");
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка хранилища чата".into())
}

fn open_database(path: &str) -> Result<Connection, Box<dyn std::error::Error>> {
    if let Some(parent) = std::path::Path::new(path).parent() { std::fs::create_dir_all(parent)?; }
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            last_read_message_id INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL REFERENCES users(id),
            client_message_id TEXT UNIQUE,
            body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
            sent_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, id);
         CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);"
    )?;
    Ok(connection)
}

fn token_hash(token: &str) -> String { format!("{:x}", Sha256::digest(token.as_bytes())) }

fn random_token() -> String {
    let mut bytes = [0_u8; 48];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn user_by_id(connection: &Connection, id: i64) -> Result<User, ApiError> {
    connection.query_row(
        "SELECT id, username, display_name FROM users WHERE id = ?1", [id],
        |row| Ok(User { id: row.get(0)?, username: row.get(1)?, display_name: row.get(2)? }),
    ).map_err(sql_error)
}

fn unread_count(connection: &Connection, user_id: i64) -> Result<i64, ApiError> {
    connection.query_row(
        "SELECT COUNT(*) FROM messages m JOIN users u ON u.id = ?1
         WHERE m.id > u.last_read_message_id AND m.sender_id != ?1", [user_id], |row| row.get(0),
    ).map_err(sql_error)
}

fn record_login_failure(state: &AppState, key: &str) {
    if let Ok(mut attempts) = state.login_attempts.lock() {
        let now = Instant::now();
        let recent = attempts.entry(key.to_owned()).or_default();
        recent.retain(|attempt| now.duration_since(*attempt) < Duration::from_secs(600));
        recent.push(now);
    }
}

fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<User, ApiError> {
    let value = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).unwrap_or("");
    let token = value.strip_prefix("Bearer ").filter(|token| token.len() >= 40)
        .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "Войдите в аккаунт чата".into()))?;
    let connection = state.db.lock().map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Хранилище временно недоступно".into()))?;
    let user_id = connection.query_row(
        "SELECT user_id FROM sessions WHERE token_hash = ?1 AND expires_at > ?2",
        params![token_hash(token), Utc::now().to_rfc3339()], |row| row.get::<_, i64>(0),
    ).optional().map_err(sql_error)?
     .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "Сессия истекла. Войдите снова".into()))?;
    user_by_id(&connection, user_id)
}

async fn health() -> impl IntoResponse { (StatusCode::OK, "ok") }

async fn login(State(state): State<AppState>, headers: HeaderMap, Json(request): Json<LoginRequest>) -> Result<Json<LoginResponse>, ApiError> {
    let username = request.username.trim();
    if username.is_empty() || request.password.is_empty() || username.len() > 64 || request.password.len() > 256 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Проверьте логин и пароль".into()));
    }
    let remote = headers.get("x-real-ip").and_then(|v| v.to_str().ok()).unwrap_or("unknown");
    let attempt_key = format!("{}:{}", remote, username.to_lowercase());
    {
        let mut attempts = state.login_attempts.lock().map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Хранилище временно недоступно".into()))?;
        let now = Instant::now();
        let recent = attempts.entry(attempt_key.clone()).or_default();
        recent.retain(|attempt| now.duration_since(*attempt) < Duration::from_secs(600));
        if recent.len() >= 8 { return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "Слишком много попыток. Попробуйте через несколько минут".into())); }
    }
    let connection = state.db.lock().map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Хранилище временно недоступно".into()))?;
    let record = connection.query_row(
        "SELECT id, username, display_name, password_hash FROM users WHERE username = ?1 COLLATE NOCASE",
        [username], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
    ).optional().map_err(sql_error)?;
    let Some((user_id, username, display_name, hash)) = record else {
        record_login_failure(&state, &attempt_key);
        eprintln!("chat login rejected for unknown username from {remote}");
        return Err(ApiError(StatusCode::UNAUTHORIZED, "Неверный логин или пароль".into()));
    };
    let parsed = PasswordHash::new(&hash).map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Не удалось проверить пароль".into()))?;
    if Argon2::default().verify_password(request.password.as_bytes(), &parsed).is_err() {
        record_login_failure(&state, &attempt_key);
        eprintln!("chat login rejected for {username} from {remote}");
        return Err(ApiError(StatusCode::UNAUTHORIZED, "Неверный логин или пароль".into()));
    }
    let token = random_token();
    if let Ok(mut attempts) = state.login_attempts.lock() { attempts.remove(&attempt_key); }
    let expiry = (Utc::now() + ChronoDuration::days(SESSION_DAYS)).to_rfc3339();
    connection.execute("DELETE FROM sessions WHERE expires_at <= ?1", [Utc::now().to_rfc3339()]).map_err(sql_error)?;
    connection.execute("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)", params![token_hash(&token), user_id, expiry]).map_err(sql_error)?;
    let user = User { id: user_id, username, display_name };
    let unread_count = unread_count(&connection, user_id)?;
    Ok(Json(LoginResponse { token, user, unread_count }))
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<MeResponse>, ApiError> {
    let user = authenticate(&state, &headers)?;
    let connection = state.db.lock().map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Хранилище временно недоступно".into()))?;
    let unread_count = unread_count(&connection, user.id)?;
    Ok(Json(MeResponse { user, unread_count }))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<StatusCode, ApiError> {
    let value = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).unwrap_or("");
    let token = value.strip_prefix("Bearer ").ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "Нет активной сессии".into()))?;
    let connection = state.db.lock().map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Хранилище временно недоступно".into()))?;
    connection.execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash(token)]).map_err(sql_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn history(State(state): State<AppState>, headers: HeaderMap, Query(query): Query<HistoryQuery>) -> Result<Json<HistoryResponse>, ApiError> {
    let _user = authenticate(&state, &headers)?;
    let before = query.before.unwrap_or(i64::MAX);
    let limit = query.limit.unwrap_or(60).clamp(1, 100) as usize;
    let connection = state.db.lock().map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Хранилище временно недоступно".into()))?;
    let mut statement = connection.prepare(
        "SELECT m.id, m.sender_id, u.display_name, m.body, m.sent_at
         FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id < ?1 ORDER BY m.id DESC LIMIT ?2"
    ).map_err(sql_error)?;
    let rows = statement.query_map(params![before, limit as i64 + 1], |row| Ok(ChatMessage {
        id: row.get(0)?, sender_id: row.get(1)?, sender_name: row.get(2)?, body: row.get(3)?, sent_at: row.get(4)?,
    })).map_err(sql_error)?;
    let mut messages = rows.collect::<Result<Vec<_>, _>>().map_err(sql_error)?;
    let has_more = messages.len() > limit;
    messages.truncate(limit);
    messages.reverse();
    Ok(Json(HistoryResponse { messages, has_more }))
}

async fn send_message(State(state): State<AppState>, headers: HeaderMap, Json(request): Json<SendMessageRequest>) -> Result<Json<ChatMessage>, ApiError> {
    let user = authenticate(&state, &headers)?;
    let body = request.body.trim();
    let chars = body.chars().count();
    if chars == 0 || chars > MAX_MESSAGE_CHARS { return Err(ApiError(StatusCode::BAD_REQUEST, "Сообщение должно содержать от 1 до 4000 символов".into())); }
    if request.client_message_id.len() > 64 || request.client_message_id.is_empty() { return Err(ApiError(StatusCode::BAD_REQUEST, "Не удалось проверить отправку сообщения".into())); }
    let sent_at = Utc::now().to_rfc3339();
    let connection = state.db.lock().map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Хранилище временно недоступно".into()))?;
    connection.execute("INSERT INTO messages(sender_id, client_message_id, body, sent_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(client_message_id) DO NOTHING", params![user.id, request.client_message_id, body, sent_at]).map_err(sql_error)?;
    let message = connection.query_row(
        "SELECT m.id, m.sender_id, u.display_name, m.body, m.sent_at FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.client_message_id = ?1",
        [&request.client_message_id], |row| Ok(ChatMessage { id: row.get(0)?, sender_id: row.get(1)?, sender_name: row.get(2)?, body: row.get(3)?, sent_at: row.get(4)? }),
    ).map_err(sql_error)?;
    drop(connection);
    let _ = state.events.send(MessageEvent { message_id: message.id });
    Ok(Json(message))
}

async fn mark_read(State(state): State<AppState>, headers: HeaderMap, Json(request): Json<ReadRequest>) -> Result<StatusCode, ApiError> {
    let user = authenticate(&state, &headers)?;
    let connection = state.db.lock().map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Хранилище временно недоступно".into()))?;
    connection.execute("UPDATE users SET last_read_message_id = MAX(last_read_message_id, ?1) WHERE id = ?2", params![request.last_read_message_id.max(0), user.id]).map_err(sql_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_ws_ticket(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<TicketResponse>, ApiError> {
    let user = authenticate(&state, &headers)?;
    let ticket = random_token();
    let mut tickets = state.ws_tickets.lock().map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Хранилище временно недоступно".into()))?;
    tickets.retain(|_, (_, expires)| *expires > Utc::now());
    tickets.insert(ticket.clone(), (user.id, Utc::now() + ChronoDuration::seconds(60)));
    Ok(Json(TicketResponse { ticket }))
}

async fn websocket(State(state): State<AppState>, Query(query): Query<TicketQuery>, upgrade: WebSocketUpgrade) -> Result<Response, ApiError> {
    let user_id = state.ws_tickets.lock().map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Хранилище временно недоступно".into()))?
        .remove(&query.ticket).filter(|(_, expiry)| *expiry > Utc::now()).map(|(user_id, _)| user_id)
        .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "Ссылка подключения устарела".into()))?;
    Ok(upgrade.on_upgrade(move |socket| handle_socket(socket, state, user_id)))
}

async fn handle_socket(mut socket: WebSocket, state: AppState, user_id: i64) {
    let mut receiver = state.events.subscribe();
    let _ = socket.send(Message::Text(format!("{{\"type\":\"ready\",\"userId\":{user_id}}}").into())).await;
    loop {
        tokio::select! {
            event = receiver.recv() => match event {
                Ok(event) => {
                    let payload = serde_json::to_string(&event).unwrap_or_else(|_| "{}".into());
                    if socket.send(Message::Text(payload.into())).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(Message::Ping(data))) => if socket.send(Message::Pong(data)).await.is_err() { break; },
                _ => {}
            }
        }
    }
}

async fn bootstrap_users(database: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)?;
    let users: Vec<BootstrapUser> = serde_json::from_str(&input)?;
    if users.len() != 2 { return Err("Bootstrap expects exactly two users".into()); }
    let connection = open_database(database)?;
    let existing: i64 = connection.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
    if existing != 0 { return Err("Users already exist; refusing to overwrite accounts".into()); }
    for user in users {
        let salt = SaltString::generate(&mut OsRng);
        let password_hash = Argon2::default().hash_password(user.password.as_bytes(), &salt)
            .map_err(|error| std::io::Error::other(error.to_string()))?.to_string();
        connection.execute("INSERT INTO users(username, display_name, password_hash) VALUES (?1, ?2, ?3)", params![user.username, user.display_name, password_hash])?;
    }
    println!("Created exactly two chat accounts.");
    Ok(())
}

fn build_router(state: AppState) -> Router {
    let origins = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:1420"]
        .map(|origin| origin.parse().expect("valid origin"));
    let cors = CorsLayer::new().allow_origin(AllowOrigin::list(origins)).allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);
    Router::new()
        .route("/api/chat/health", get(health))
        .route("/api/chat/auth/login", post(login))
        .route("/api/chat/auth/me", get(me))
        .route("/api/chat/auth/logout", post(logout))
        .route("/api/chat/messages", get(history).post(send_message))
        .route("/api/chat/read", post(mark_read))
        .route("/api/chat/ws-ticket", post(create_ws_ticket))
        .route("/api/chat/events", get(websocket))
        .layer(cors)
        .with_state(state)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    let database = env::var("EASY_PTO_CHAT_DB").unwrap_or_else(|_| "/var/lib/easypto-chat/chat.sqlite3".into());
    if args.get(1).is_some_and(|arg| arg == "bootstrap-users") { bootstrap_users(&database).await?; return Ok(()); }
    let connection = open_database(&database)?;
    let user_count: i64 = connection.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
    if user_count != 2 { return Err(format!("Expected two provisioned chat users, found {user_count}. Run bootstrap-users first.").into()); }
    let (events, _) = broadcast::channel(256);
    let state = AppState { db: Arc::new(Mutex::new(connection)), events, ws_tickets: Arc::new(Mutex::new(HashMap::new())), login_attempts: Arc::new(Mutex::new(HashMap::new())) };
    let address: SocketAddr = env::var("EASY_PTO_CHAT_BIND").unwrap_or_else(|_| "127.0.0.1:8765".into()).parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    eprintln!("easyPTO chat listening on {address}");
    axum::serve(listener, build_router(state)).with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; }).await?;
    Ok(())
}
