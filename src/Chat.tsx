import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Chat.css";

const API_BASE = import.meta.env.VITE_CHAT_API_BASE ?? "https://faallleenn.asia/api/chat";

type ChatUser = { id: number; username: string; displayName: string };
type ChatMessage = { id: number; senderId: number; senderName: string; body: string; sentAt: string; pending?: boolean };
type LoginResponse = { token: string; user: ChatUser; unreadCount: number };
type MeResponse = { user: ChatUser; unreadCount: number };
type HistoryResponse = { messages: ChatMessage[]; hasMore: boolean };

async function request<T>(path: string, token?: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `Ошибка связи с чатом (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function mergeMessages(current: ChatMessage[], next: ChatMessage[]) {
  const byId = new Map(current.filter((message) => message.id > 0).map((message) => [message.id, message]));
  for (const message of next) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function formatClock(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function dayLabel(value: string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return "Сегодня";
  if (sameDay(date, yesterday)) return "Вчера";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" }).format(date);
}

function ChatIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 11.6a7.9 7.9 0 0 1-8.1 7.8 8.5 8.5 0 0 1-3.3-.7L4 20l1.2-4.1a7.5 7.5 0 0 1-1.1-4.1A7.9 7.9 0 0 1 12.2 4a7.9 7.9 0 0 1 8 7.6Z" /><path d="M8 11.8h8M8 14.8h5" /></svg>;
}

function SendIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 3-7.2 18-3.5-7.3L3 10.2 21 3Z" /><path d="m10.3 13.7 4.2-4.2" /></svg>;
}

function ArrowDownIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v15M6 13l6 6 6-6" /></svg>;
}

export function ChatModule({ active, onUnreadChange, onOpen }: { active: boolean; onUnreadChange: (count: number) => void; onOpen: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<ChatUser | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<ChatMessage | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollHeightBeforeLoad = useRef(0);
  const seenToastIds = useRef(new Set<number>());
  const retryMessage = useRef<{ body: string; id: string } | null>(null);

  const partnerName = useMemo(() => user?.username === "owner" ? "Клиент" : "Владелец", [user]);

  useEffect(() => {
    let alive = true;
    invoke<string | null>("chat_get_session_token")
      .then((savedToken) => { if (alive) setToken(savedToken); })
      .catch(() => { if (alive) setToken(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!token) {
      setUser(null);
      setMessages([]);
      setUnread(0);
      onUnreadChange(0);
      return;
    }
    let alive = true;
    setLoading(true);
    Promise.all([
      request<MeResponse>("/auth/me", token),
      request<HistoryResponse>("/messages?limit=60", token),
    ]).then(([me, history]) => {
      if (!alive) return;
      setUser(me.user);
      const unreadCount = active ? 0 : me.unreadCount;
      setUnread(unreadCount);
      onUnreadChange(unreadCount);
      setMessages(history.messages);
      setHasMore(history.hasMore);
      if (active) {
        const latestId = Math.max(...history.messages.map((message) => message.id), 0);
        if (latestId > 0) void request<void>("/read", token, { lastReadMessageId: latestId }).catch(() => undefined);
      }
      request<HistoryResponse>("/messages?limit=1", token).then((latest) => {
        if (!alive || latest.messages.length === 0) return;
        bottomRef.current?.scrollIntoView({ behavior: "instant", block: "end" });
      }).catch(() => undefined);
    }).catch(async (reason: unknown) => {
      if (!alive) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      if (reason instanceof Error && reason.message.includes("Сессия истекла")) {
        await invoke("chat_clear_session_token").catch(() => undefined);
        setToken(null);
      }
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token, active, onUnreadChange]);

  useEffect(() => {
    if (!token || !user) return;
    let alive = true;
    let socket: WebSocket | null = null;
    let reconnectTimer = 0;
    let pollTimer = 0;

    const syncLatest = async () => {
      try {
        const history = await request<HistoryResponse>("/messages?limit=60", token);
        const me = active ? null : await request<MeResponse>("/auth/me", token);
        if (!alive) return;
        setMessages((current) => {
          const previousIds = new Set(current.map((message) => message.id));
          const incoming = history.messages.filter((message) => !previousIds.has(message.id) && message.senderId !== user.id);
          if (!active && document.visibilityState === "visible" && incoming.length) {
            const last = incoming[incoming.length - 1];
            if (!seenToastIds.current.has(last.id)) {
              seenToastIds.current.add(last.id);
              setToast(last);
              window.setTimeout(() => setToast((currentToast) => currentToast?.id === last.id ? null : currentToast), 6500);
            }
          }
          return mergeMessages(current, history.messages);
        });
        if (active) {
          const latestId = Math.max(...history.messages.map((message) => message.id), 0);
          setUnread(0);
          onUnreadChange(0);
          if (latestId > 0) void request<void>("/read", token, { lastReadMessageId: latestId }).catch(() => undefined);
        } else if (me) {
          setUnread(me.unreadCount);
          onUnreadChange(me.unreadCount);
        }
        setHasMore(history.hasMore);
      } catch {
        if (alive) setConnected(false);
      }
    };

    const connect = async () => {
      try {
        const { ticket } = await request<{ ticket: string }>("/ws-ticket", token, {});
        if (!alive) return;
        const url = new URL(`${API_BASE}/events`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("ticket", ticket);
        socket = new WebSocket(url.toString());
        socket.onopen = () => { if (alive) setConnected(true); };
        socket.onmessage = () => { void syncLatest(); };
        socket.onclose = () => {
          if (!alive) return;
          setConnected(false);
          reconnectTimer = window.setTimeout(() => void connect(), 2200);
        };
        socket.onerror = () => socket?.close();
      } catch {
        if (!alive) return;
        setConnected(false);
        reconnectTimer = window.setTimeout(() => void connect(), 5000);
      }
    };

    void connect();
    pollTimer = window.setInterval(() => void syncLatest(), 12000);
    return () => {
      alive = false;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(pollTimer);
      socket?.close();
    };
  }, [token, user, active, onUnreadChange]);

  useEffect(() => {
    if (!active || !user || messages.length === 0) return;
    const latestId = Math.max(...messages.filter((message) => message.id > 0).map((message) => message.id), 0);
    if (latestId === 0) return;
    setUnread(0);
    onUnreadChange(0);
    void request<void>("/read", token ?? undefined, { lastReadMessageId: latestId }).catch(() => undefined);
  }, [active, user, messages, token, onUnreadChange]);

  useEffect(() => {
    if (active && messages.length && scrollHeightBeforeLoad.current === 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [active, messages.length]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginBusy(true);
    setError("");
    try {
      const result = await request<LoginResponse>("/auth/login", undefined, { username: username.trim(), password });
      await invoke("chat_store_session_token", { token: result.token });
      setUser(result.user);
      const unreadCount = active ? 0 : result.unreadCount;
      setUnread(unreadCount);
      onUnreadChange(unreadCount);
      setPassword("");
      setToken(result.token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoginBusy(false);
    }
  };

  const logout = async () => {
    if (token) await request<void>("/auth/logout", token, {}).catch(() => undefined);
    await invoke("chat_clear_session_token").catch(() => undefined);
    setToken(null);
    setUser(null);
    setMessages([]);
    setError("");
  };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !token || sending) return;
    setSending(true);
    setError("");
    setDraft("");
    const localId = -Date.now();
    const clientMessageId = retryMessage.current?.body === body ? retryMessage.current.id : crypto.randomUUID();
    retryMessage.current = { body, id: clientMessageId };
    const optimistic: ChatMessage = { id: localId, senderId: user?.id ?? 0, senderName: user?.displayName ?? "Вы", body, sentAt: new Date().toISOString(), pending: true };
    setMessages((current) => [...current, optimistic]);
    try {
      const saved = await request<ChatMessage>("/messages", token, { body, clientMessageId });
      setMessages((current) => mergeMessages(current.filter((message) => message.id !== localId), [saved]));
      retryMessage.current = null;
    } catch (reason) {
      setDraft(body);
      setMessages((current) => current.filter((message) => message.id !== localId));
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  const loadOlder = async () => {
    if (!token || !messages.length || !hasMore) return;
    const viewport = scrollRef.current;
    if (viewport) scrollHeightBeforeLoad.current = viewport.scrollHeight;
    try {
      const older = await request<HistoryResponse>(`/messages?limit=60&before=${messages.find((message) => message.id > 0)?.id ?? messages[0].id}`, token);
      setMessages((current) => mergeMessages(older.messages, current));
      setHasMore(older.hasMore);
      requestAnimationFrame(() => {
        if (viewport) viewport.scrollTop = viewport.scrollHeight - scrollHeightBeforeLoad.current;
        scrollHeightBeforeLoad.current = 0;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const days = useMemo(() => {
    const groups: { label: string; messages: ChatMessage[] }[] = [];
    for (const message of messages) {
      const label = dayLabel(message.sentAt);
      let group = groups[groups.length - 1];
      if (!group || group.label !== label) { group = { label, messages: [] }; groups.push(group); }
      group.messages.push(message);
    }
    return groups;
  }, [messages]);

  return <>
    {active && <section className="chat-screen" aria-labelledby="chat-title">
      {!user ? <div className="chat-login-wrap">
        <form className="chat-login-card" onSubmit={login}>
          <span className="chat-login-mark"><ChatIcon /></span>
          <div className="chat-eyebrow">EASYPTO · СВЯЗЬ</div>
          <h1 id="chat-title">Чат с клиентом</h1>
          <p>Войдите, чтобы открыть переписку. Доступ есть только у участников чата.</p>
          <label>Логин<input autoComplete="username" autoFocus required value={username} onChange={(event) => setUsername(event.currentTarget.value)} /></label>
          <label>Пароль<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.currentTarget.value)} /></label>
          {error && <div className="chat-form-error" role="alert">{error}</div>}
          <button className="chat-login-button" type="submit" disabled={loginBusy}>{loginBusy ? "Входим…" : "Войти в чат"}<span aria-hidden="true">→</span></button>
          <div className="chat-login-foot"><span className="chat-lock-dot" /> Переписка доступна только по аккаунтам</div>
        </form>
      </div> : <div className="messenger-shell">
        <aside className="messenger-rail">
          <div className="messenger-rail-head"><div><span className="chat-eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</span><h2>Сообщения</h2></div><button className="chat-logout" type="button" onClick={() => void logout()} aria-label="Выйти из чата" title="Выйти из чата">↗</button></div>
          <div className="chat-search-static"><span>⌕</span> Личная переписка</div>
          <button className="conversation-row selected" type="button">
            <span className="conversation-avatar">{partnerName.slice(0, 1)}</span>
            <span className="conversation-copy"><strong>{partnerName}</strong><span>{messages[messages.length - 1]?.body ?? "Начните переписку"}</span></span>
            <span className="conversation-meta">{messages.length ? formatClock(messages[messages.length - 1].sentAt) : ""}{unread > 0 && <i>{unread}</i>}</span>
          </button>
          <div className="messenger-rail-note"><span>2</span> участника имеют доступ к этой переписке</div>
          <div className="messenger-account"><span className="account-avatar">{user.displayName.slice(0, 1)}</span><span><strong>{user.displayName}</strong><small>Аккаунт easyPTO</small></span><span className="account-online" title="Вы вошли" /></div>
        </aside>
        <section className="conversation-panel" aria-label={`Переписка: ${partnerName}`}>
          <header className="conversation-header"><span className="conversation-avatar large">{partnerName.slice(0, 1)}</span><div><h2 id="chat-title">{partnerName}</h2><span><i className={connected ? "status-online" : "status-offline"} />{connected ? "В сети" : "Подключаемся…"}</span></div><div className="header-thread-label"><ChatIcon />Личная переписка</div></header>
          {error && <div className="chat-inline-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Закрыть">×</button></div>}
          <div className="message-scroll" ref={scrollRef}>
            {hasMore && <button className="load-older" type="button" onClick={() => void loadOlder()}>Загрузить предыдущие сообщения</button>}
            {loading ? <div className="chat-loading"><span /> Загружаем переписку…</div> : messages.length === 0 ? <div className="chat-empty"><div className="chat-empty-icon"><ChatIcon /></div><strong>Пока тихо</strong><span>Отправьте первое сообщение — оно появится здесь.</span></div> : days.map((group) => <div className="message-day" key={group.label}><div className="day-divider"><span>{group.label}</span></div>{group.messages.map((message) => {
              const own = message.senderId === user.id;
              return <article className={`message-row${own ? " own" : ""}`} key={message.id}><div className="message-avatar">{own ? user.displayName.slice(0, 1) : partnerName.slice(0, 1)}</div><div className="message-content"><div className="message-byline"><strong>{own ? "Вы" : message.senderName}</strong><time>{formatClock(message.sentAt)}</time></div><div className={`message-bubble${own ? " own" : ""}${message.pending ? " pending" : ""}`}>{message.body}{own && <span className="message-delivery" aria-label={message.pending ? "Отправляется" : "Отправлено"}>{message.pending ? "◷" : "✓"}</span>}</div></div></article>;
            })}</div>)}
            <div ref={bottomRef} />
          </div>
          <form className="composer" onSubmit={send}><div className="composer-box"><textarea aria-label="Текст сообщения" placeholder="Напишите сообщение…" rows={1} maxLength={4000} value={draft} onChange={(event) => { if (retryMessage.current && event.currentTarget.value.trim() !== retryMessage.current.body) retryMessage.current = null; setDraft(event.currentTarget.value); }} onKeyDown={handleComposerKey} /><div className="composer-meta"><span>Enter — отправить · Shift+Enter — новая строка</span><span>{draft.length}/4000</span></div></div><button className="send-message" type="submit" disabled={!draft.trim() || sending} aria-label="Отправить сообщение"><SendIcon /></button></form>
          <div className="conversation-encryption-note"><span>●</span> Сообщения передаются по защищённому соединению</div>
        </section>
      </div>}
    </section>}
    {toast && !active && <button type="button" className="chat-toast" onClick={() => { setToast(null); onOpen(); }} aria-label="Открыть новое сообщение">
      <span className="toast-mark"><ChatIcon /></span><span className="toast-copy"><strong>{toast.senderName}</strong><span>{toast.body}</span></span><span className="toast-open"><ArrowDownIcon /></span>
    </button>}
  </>;
}
