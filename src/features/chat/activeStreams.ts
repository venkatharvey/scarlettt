// In-flight responses, kept outside React so they outlive the component.
//
// ChatPage unmounts whenever you open Settings or the models library, and a
// response generating at that moment used to vanish from view entirely: the new
// instance mounts with isLoading false and no counters, so returning looked
// exactly like the reply had died. It hadn't — the tokens were still arriving and
// the message still saved — but nothing on screen said so.
//
// Keyed by session so switching between two chats shows the right one, and so a
// reply that finishes while you're elsewhere can still be matched up.

/**
 * A tool call the model made during this reply, tracked live so its card can move
 * from "waiting for you" to "running" to a result as events arrive. Kept in the
 * store (not component state) for the same reason the tokens are: the reply, and
 * an approval prompt inside it, must survive ChatPage unmounting.
 */
export interface StreamToolCall {
    callId: string;
    /** Namespaced name the model called (`serverid__tool`). */
    tool: string;
    server: string;
    toolName: string;
    arguments: unknown;
    status: 'awaiting-approval' | 'running' | 'done';
    result?: string;
    isError?: boolean;
    /** How it resolved: allow-once | allow-session | auto | deny | offline. */
    decision?: string;
}

export interface ActiveStream {
    sessionId: string;
    /** `Date.now()` when the request went out — drives the elapsed counter. */
    startedAt: number;
    tokens: number;
    /** Everything streamed so far, so returning mid-reply shows the partial text. */
    content: string;
    /** Tool calls this reply has made, in order. */
    toolCalls: StreamToolCall[];
}

const streams = new Map<string, ActiveStream>();
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach(listener => listener());
}

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * The stream for a session, or undefined. The same object identity is returned
 * until something actually changes, which is what `useSyncExternalStore` needs to
 * avoid re-rendering forever.
 */
export function getStream(sessionId?: string): ActiveStream | undefined {
    return sessionId ? streams.get(sessionId) : undefined;
}

export function beginStream(sessionId: string): void {
    streams.set(sessionId, { sessionId, startedAt: Date.now(), tokens: 0, content: "", toolCalls: [] });
    emit();
}

export function appendToken(sessionId: string, token: string): void {
    const current = streams.get(sessionId);
    if (!current) return;
    // Replaced rather than mutated: the snapshot has to change identity for
    // subscribers to see anything.
    streams.set(sessionId, {
        ...current,
        tokens: current.tokens + 1,
        content: current.content + token,
    });
    emit();
}

/** A new tool call the model made. `needsApproval` decides its initial state. */
export function appendToolCall(
    sessionId: string,
    call: Omit<StreamToolCall, 'status'>,
    needsApproval: boolean,
): void {
    const current = streams.get(sessionId);
    if (!current) return;
    streams.set(sessionId, {
        ...current,
        toolCalls: [...current.toolCalls, { ...call, status: needsApproval ? 'awaiting-approval' : 'running' }],
    });
    emit();
}

/** Optimistically mark a call running the moment the user approves it, before the
 *  result event arrives — so the approval buttons don't linger. */
export function markToolRunning(sessionId: string, callId: string): void {
    updateToolCall(sessionId, callId, { status: 'running' });
}

/** The call finished (or was denied): fill in its outcome. */
export function resolveToolCall(
    sessionId: string,
    callId: string,
    outcome: { result: string; isError: boolean; decision: string },
): void {
    updateToolCall(sessionId, callId, { ...outcome, status: 'done' });
}

function updateToolCall(sessionId: string, callId: string, patch: Partial<StreamToolCall>): void {
    const current = streams.get(sessionId);
    if (!current) return;
    let changed = false;
    const toolCalls = current.toolCalls.map(c => {
        if (c.callId !== callId) return c;
        changed = true;
        return { ...c, ...patch };
    });
    if (!changed) return;
    streams.set(sessionId, { ...current, toolCalls });
    emit();
}

export function endStream(sessionId: string): void {
    if (streams.delete(sessionId)) emit();
}
