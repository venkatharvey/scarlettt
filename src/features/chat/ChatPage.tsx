import AIChatView from "./components/ChatView/AIChatView";
import HumanChatView from "./components/ChatView/HumanChatView";
import LoadingGrid from "./components/ChatView/LoadingGrid"; // Import custom loading component
import ChatInput from "./components/ChatInput/ChatInput";
import { contextNoticeLevel } from "./components/ChatInput/ContextMeter";
import { useState, useRef, useEffect, useMemo, useCallback, useSyncExternalStore } from "react";
import { useOllama, canUseTools } from "../../hooks/useOllama";
import { useChatStorage, MessageStats, ToolInteraction } from "../../hooks/useChatStorage";
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useSettings } from "../../hooks/useSettings";
import { useSystemInfo, memoryCeilingBytes, compressedCeilingBytes, withReloadableMemory, InstalledModel } from "../../hooks/useSystemInfo";
import { useLoadedModel } from "../../hooks/useLoadedModel";
import { useUserName } from "../../hooks/useUserName";
import { resolveContext, baseName } from "../models/modelFacts";
import { cachedFacts, rememberFacts } from "../models/contextCache";
import { notify, dismiss, MISSING_MODEL_NOTICE } from "../notices/notices";
import { pushNotify, replyPreview } from "../notices/push";
import { renderGreeting, sessionGreetingTemplate } from "./greeting";
import { splitThinking } from "./thinking";
import GenerationStatus from "./components/ChatView/GenerationStatus";
import { subscribe as subscribeStreams, getStream, beginStream, appendToken, endStream, appendToolCall, markToolRunning, resolveToolCall } from "./activeStreams";
import { ToolDecision } from "./components/ChatView/ToolCallCard";

/** What Ollama reports on the final chunk, forwarded by the `chat-done` event. */
interface ChatDonePayload {
    stream_id?: string;
    total_duration?: number | null;
    prompt_eval_count?: number | null;
    eval_count?: number | null;
}

interface ChatTokenPayload {
    stream_id?: string;
    token: string;
}

/** Emitted before a tool runs. Carries the arguments so the card shows the real call. */
interface ChatToolCallPayload {
    stream_id?: string;
    call_id: string;
    tool: string;
    server: string;
    tool_name: string;
    arguments: unknown;
    needs_approval: boolean;
}

/** Emitted after a tool resolves — run, denied, timed out, or blocked. */
interface ChatToolResultPayload {
    stream_id?: string;
    call_id: string;
    tool: string;
    is_error: boolean;
    content: string;
    decision: string;
}

/**
 * Fired once a response has been written to the database. A ChatPage that was
 * unmounted mid-stream (the user opened Settings, say) misses every token that
 * arrived while it was gone, so on returning it needs a nudge to re-read the
 * finished message rather than showing the conversation without it.
 */
const STREAM_COMPLETE_EVENT = "scarlettt:stream-complete";

export interface ChatMessage extends MessageStats {
    role: string;
    content: string;
    timestamp?: string;
    /** Tool calls made during this assistant turn; rendered as cards in the reply. */
    tool_calls?: ToolInteraction[];
}

interface ChatPageProps {
    model?: string;
    onModelSelect?: (model: string) => void;
    onBrowseModels?: () => void;
    sessionId?: string;
    onSessionChange?: () => void;
    onSessionCreate?: (sessionId: string) => void;
}

export default function ChatPage({ model = "mistral", onModelSelect, onBrowseModels, sessionId, onSessionChange, onSessionCreate }: ChatPageProps) {
    const [chats, setChats] = useState<ChatMessage[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    /**
     * The reply currently generating, so it can be stopped.
     *
     * A ref rather than state: the id is only ever read at the moment of a click,
     * and re-rendering the whole page on every send to store it would be work for
     * nothing.
     */
    const activeStreamIdRef = useRef<string | null>(null);
    /**
     * The response currently generating for this chat, read from a store that
     * lives outside React. Component state would be lost the moment you opened
     * Settings, taking the progress indicator with it and making a perfectly
     * healthy reply look dead.
     */
    const activeStream = useSyncExternalStore(subscribeStreams, () => getStream(sessionId));
    /**
     * Messages typed while a reply is still generating.
     *
     * Held in a ref as well as state because the drain effect below reads the queue
     * from inside an async callback, where the state closure would be a render old.
     * The state copy exists purely so the pending bubbles re-render.
     */
    const pendingRef = useRef<string[]>([]);
    const [pending, setPending] = useState<string[]>([]);
    /** Guards the gap between starting a send and `isLoading` actually flipping. */
    const drainingRef = useRef(false);

    const chatContainerRef = useRef<HTMLDivElement>(null);
    const { streamMessage, stopMessage, getRemoteModelDetails, listModels } = useOllama();
    const { getMessages, saveMessage, createSession, deleteMessagesAfter, branchSession, getSessions, recordSessionContext } = useChatStorage();
    const { settings } = useSettings();
    const { systemInfo, listInstalledModels, getModelDetails } = useSystemInfo();

    // Drawn once per app launch. ChatPage remounts when a session is opened or a
    // new chat started, so the template comes from sessionStorage rather than
    // component state — otherwise every remount would reshuffle the line.
    const userName = useUserName();
    const greetingTemplate = useMemo(() => sessionGreetingTemplate(), []);
    const greeting = renderGreeting(greetingTemplate, userName);

    // What this model already holds resident, if it's the loaded one. Credited back
    // into free memory before sizing, because reloading at a new context releases
    // the old allocation first — otherwise a chat opened on an already-loaded model
    // sizes against memory the model itself is holding and collapses to 8k. Same
    // `withReloadableMemory` invariant Settings uses; guarded on identity because
    // `useLoadedModel` falls back to any resident model.
    const { loaded } = useLoadedModel(model);
    const heldForModel = loaded && loaded.name === model ? loaded.size : undefined;

    // Context depends on the model's own architecture and this machine's memory,
    // so it's resolved per model rather than being a single stored number.
    //
    // Seeded from `contextCache` rather than starting undefined. The async lookup
    // below is quick, but a send during it used to pass no context at all, which is
    // Ollama's 4096 applied silently — and, because an option-less request inherits
    // whatever instance is already loaded, that 4k then sticks for the session. The
    // cache holds the *inputs*, so the number is re-derived here against current
    // memory and settings rather than replayed.
    const resolveFrom = (facts: ReturnType<typeof cachedFacts>) => {
        const sizingSystem = withReloadableMemory(systemInfo, heldForModel);
        return resolveContext(settings.contextMode, settings.contextCeiling, {
            modelMax: facts?.modelMax,
            kvBytesPerToken: facts?.kvBytesPerToken,
            architecture: facts?.architecture,
            weightsBytes: facts?.weightsBytes,
            memoryCeiling: memoryCeilingBytes(sizingSystem, settings.reservedMemoryGb),
            memoryCeilingFallback: compressedCeilingBytes(sizingSystem, settings.reservedMemoryGb),
        });
    };
    const [numCtx, setNumCtx] = useState<number>(() => resolveFrom(cachedFacts(model)));
    /**
     * Says so when the selected model isn't installed, instead of quietly running
     * at Ollama's 4096 — the one case left where the app can't derive a context
     * from the model, because it has no model to derive it from.
     *
     * The `installed.length` guard is the whole reason this is safe to raise:
     * `listInstalledModels` swallows its error and returns an empty array, so
     * "nothing installed" and "Ollama isn't up yet" look identical, and Ollama
     * takes a second or more to become ready at launch. Firing on an empty list
     * would accuse the user of a missing model on every cold start.
     */
    const reportMissingModel = async (installed: InstalledModel[], entry?: InstalledModel) => {
        if (entry) { dismiss(MISSING_MODEL_NOTICE); return; }
        // Can't tell "absent" from "backend not ready" — say nothing either way.
        if (installed.length === 0) return;

        // A name Ollama's library doesn't carry would open an empty detail page,
        // so those get pointed at search instead.
        const inLibrary = !!(await getRemoteModelDetails(baseName(model)));
        notify({
            id: MISSING_MODEL_NOTICE,
            title: `${model} isn't installed.`,
            body: inLibrary
                ? "Install it, or pick another model from the picker next to the send button."
                : "It isn't in the model library either — it may have been renamed or removed. Pick another model from the picker next to the send button.",
            action: inLibrary
                ? { kind: "install", model: baseName(model) }
                : { kind: "search", query: baseName(model) },
            actionLabel: inLibrary ? `Install ${baseName(model)}` : "Search the library",
        });
    };
    /**
     * Resolves when this model's facts are known. Awaited before a send *only* when
     * the cache had nothing for it — a first-ever use, where the seeded value is a
     * model-blind 4096 that would otherwise be pinned onto the loaded instance for
     * the session. Every other send goes out with no wait at all.
     */
    const factsReady = useRef<Promise<void> | null>(null);
    /**
     * The context this chat's replies were generated under, once it has one.
     *
     * Honoured over a freshly derived figure, so a conversation keeps meaning one
     * thing: re-deriving on every open would let earlier turns have been written at
     * 128k and later ones at 40k because free memory moved, with nothing recording
     * the change. When it no longer fits comfortably the notice below says so
     * rather than the app silently shrinking it.
     */
    const [sessionCtx, setSessionCtx] = useState<number | undefined>();
    // The model the recorded window was derived for. The window is honoured only
    // while this still matches the current model; switching models re-derives it.
    const [sessionModel, setSessionModel] = useState<string | undefined>();
    useEffect(() => {
        let cancelled = false;
        if (!sessionId) { setSessionCtx(undefined); setSessionModel(undefined); return; }
        (async () => {
            const found = (await getSessions()).find(s => s.id === sessionId);
            if (!cancelled) {
                setSessionCtx(found?.num_ctx ?? undefined);
                setSessionModel(found?.model ?? undefined);
            }
        })();
        return () => { cancelled = true; };
    }, [sessionId, getSessions]);
    useEffect(() => {
        let cancelled = false;
        // Re-derive from cache first: settings or free memory may have moved since
        // the last mount, and this costs nothing.
        setNumCtx(resolveFrom(cachedFacts(model)));
        const known = !!cachedFacts(model);
        const lookup = (async () => {
            const installed = await listInstalledModels();
            const entry = installed.find(m => m.name === model);
            const details = entry ? await getModelDetails(entry.name) : null;
            if (cancelled) return;
            if (entry) rememberFacts(model, entry, details);
            setNumCtx(resolveFrom(cachedFacts(model)));
            await reportMissingModel(installed, entry);
        })();
        factsReady.current = known ? null : lookup.catch(() => undefined);
        return () => { cancelled = true; };
        // `available_memory` is a dependency because free memory is the term that
        // usually binds — without it the context sent to Ollama is whatever was free
        // when this chat opened, while Settings shows a figure recomputed from what
        // is free now. The 512MB hysteresis on the poll is what keeps this from
        // reloading the model every few seconds. `heldForModel` is here too: when
        // this model's residency appears or clears, the reload-effective free memory
        // moves, so the context has to re-derive with it.
    }, [model, settings.contextMode, settings.contextCeiling, settings.reservedMemoryGb, systemInfo?.total_memory, systemInfo?.available_memory, systemInfo?.gpu_working_set, heldForModel]);

    const chatsRef = useRef<ChatMessage[]>([]);
    chatsRef.current = chats;

    const sessionIdRef = useRef(sessionId);
    const userHasScrolledUpRef = useRef(false);

    // Update ref when sessionId changes
    useEffect(() => {
        sessionIdRef.current = sessionId;
    }, [sessionId]);

    // Load messages when session changes
    useEffect(() => {
        if (sessionId) {
            loadMessages();
        } else {
            setChats([]);
        }
        // Reset scroll tracking on session switch
        userHasScrolledUpRef.current = false;
    }, [sessionId]);

    const loadMessages = async (id?: string) => {
        const sid = id || sessionId;
        if (!sid) return;

        try {
            const messages = await getMessages(sid);
            const chatMessages: ChatMessage[] = messages
                // A reply with no text is not a turn in the conversation — it's the
                // residue of a stop that landed before the first token. The save
                // path no longer writes these, but rows written before that fix are
                // still on disk, and they render as an empty bubble with an action
                // row and a timestamp. Dropped on read so the history reads the way
                // it would if they had never been written; nothing is deleted.
                //
                // An assistant turn with tool calls but no text is NOT residue: it
                // ran tools and its cards are the content, so it is kept.
                .filter(msg =>
                    msg.role !== 'assistant'
                    || msg.content.trim() !== ''
                    || (msg.tool_calls?.length ?? 0) > 0
                )
                .map(msg => ({
                role: msg.role,
                content: msg.content,
                timestamp: msg.timestamp,
                duration_ms: msg.duration_ms,
                prompt_tokens: msg.prompt_tokens,
                eval_tokens: msg.eval_tokens,
                tool_calls: msg.tool_calls ?? undefined,
            }));
            setChats(chatMessages);
        } catch (error) {
            console.error('Error loading messages:', error);
        }
    };

    /**
     * How much of the window this conversation occupies, as Ollama counted it.
     *
     * `prompt_eval_count` is the whole prompt for that turn, so the last reply's
     * prompt plus its own output is what the *next* request will carry — measured
     * ground truth rather than a token estimate. It lags by one turn by nature:
     * nothing is known until a reply has landed, and Ollama exposes no tokenizer
     * to count what is currently typed.
     */
    const contextUsed = useMemo(() => {
        for (let i = chats.length - 1; i >= 0; i--) {
            const c = chats[i];
            if (c.role === 'assistant' && c.prompt_tokens != null) {
                return c.prompt_tokens + (c.eval_tokens ?? 0);
            }
        }
        return undefined;
    }, [chats]);

    /**
     * The highest context threshold already dismissed for this chat.
     *
     * A level rather than a flag, so "Got it" at 80% doesn't also silence 90% and
     * the full-window notice — each is a further step towards losing the start of
     * the conversation, and only the one you actually saw should count as read.
     *
     * Kept in `sessionStorage` rather than component state because ChatPage
     * unmounts whenever Settings is opened — the same remount that used to take
     * in-flight replies with it. Acknowledging and then glancing at Settings
     * would otherwise bring the notice straight back.
     */
    const [acknowledgedLevel, setAcknowledgedLevel] = useState(0);
    useEffect(() => {
        const stored = sessionId
            ? Number(sessionStorage.getItem(`context-notice-ack:${sessionId}`))
            : 0;
        setAcknowledgedLevel(Number.isFinite(stored) ? stored : 0);
    }, [sessionId]);

    // The recorded window is honoured only while the model it was derived for is the
    // one in use. Switch models and it's re-derived instead — so a bigger-context
    // model gives its bigger window and a smaller one is capped to its own max,
    // rather than the chat staying stuck on the window the first model set.
    const contextLocked = sessionCtx !== undefined && sessionModel === model;
    // What this chat is actually running at: its recorded terms while the model is
    // unchanged, otherwise what today's machine affords the current model. The meter
    // and the notice both read this, so neither can describe a window different from
    // the one being sent.
    const effectiveCtx = contextLocked ? sessionCtx : numCtx;
    /**
     * Set when this chat's recorded context is larger than the machine would grant
     * it today — free memory has dropped since the conversation started. Only while
     * the model is unchanged; a model switch re-derives, so there's nothing stale to
     * warn about.
     *
     * The recorded value is still honoured: shrinking it silently is the drift this
     * whole mechanism exists to prevent, and it would make the transcript above
     * mean something different from the transcript below. So the trade is stated
     * instead, and the choice of what to do about it stays the user's.
     */
    const ctxExceedsToday = contextLocked && sessionCtx > numCtx ? { was: sessionCtx, now: numCtx } : undefined;
    const noticeLevel = contextNoticeLevel(contextUsed, effectiveCtx);
    const pendingNotice = noticeLevel !== null && noticeLevel > acknowledgedLevel
        ? noticeLevel
        : undefined;

    /**
     * The window filling up, told to someone who has walked away.
     *
     * Keyed on the level rather than on the boolean, so crossing 80 → 90 → 100 raises
     * three separate notifications: each is a further step towards losing the start of
     * the conversation, and collapsing them would mean the one that matters most is
     * the one that never fires.
     */
    const lastPushedLevel = useRef(0);
    useEffect(() => {
        if (!pendingNotice || pendingNotice <= lastPushedLevel.current) return;
        lastPushedLevel.current = pendingNotice;
        void pushNotify(
            settings.pushNotifications,
            "context",
            pendingNotice === 100 ? "Context window full" : `Context window ${pendingNotice}% full`,
            pendingNotice === 100
                ? "The oldest messages in this chat are now being dropped."
                : "The oldest messages will start dropping out soon.",
        );
    }, [pendingNotice, settings.pushNotifications]);
    // A different chat has its own thresholds; without this, opening a second chat
    // that is already at 90% would stay silent because the first one had been.
    useEffect(() => { lastPushedLevel.current = 0; }, [sessionId]);

    const acknowledgeContext = () => {
        if (noticeLevel === null) return;
        if (sessionId) sessionStorage.setItem(`context-notice-ack:${sessionId}`, String(noticeLevel));
        setAcknowledgedLevel(noticeLevel);
    };

    const handleScroll = () => {
        if (chatContainerRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
            // If user is within 50px of the bottom, they haven't "scrolled up" manually to read old history
            const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

            // Update ref immediately (synchronous) to prevent race conditions during streaming
            userHasScrolledUpRef.current = !isAtBottom;
        }
    };

    // Auto-scroll to bottom when new messages arrive or loading state changes
    useEffect(() => {
        // Check ref instead of state for synchronous, race-condition-free scroll detection
        if (chatContainerRef.current && !userHasScrolledUpRef.current) {
            // Use requestAnimationFrame to ensure DOM updates (like Thinking... hiding and action buttons showing) are rendered
            requestAnimationFrame(() => {
                if (chatContainerRef.current) {
                    chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
                }
            });
        }
        // `activeStream.tokens` is in here, and that is the point: without it the
        // view followed messages *appearing* but not a reply *growing*. Generation
        // start scrolled to the bottom, then the answer grew downward out of sight
        // for the whole reply, and at the end nothing pulled it back — which reads
        // exactly like the conversation vanishing. The token count changes once per
        // token, and each run schedules one frame-aligned write, so pinning costs a
        // scroll assignment rather than a layout pass per token.
    }, [chats, isLoading, activeStream?.tokens]);

    // Deliberately NOT unlistening on unmount. Navigating to Settings unmounts
    // this component while Ollama keeps generating, and tearing the listener down
    // there dropped every remaining token — the reply was then saved truncated at
    // whatever point the user navigated. The stream's own `finally` is what closes
    // these, so they live exactly as long as the request does.
    useEffect(() => {
        const reload = (e: Event) => {
            const finished = (e as CustomEvent<{ sessionId: string }>).detail?.sessionId;
            if (finished && finished === sessionIdRef.current) loadMessages(finished);
        };
        window.addEventListener(STREAM_COMPLETE_EVENT, reload);
        return () => window.removeEventListener(STREAM_COMPLETE_EVENT, reload);
    }, []);

    const unlistenRef = useRef<(() => void) | null>(null);

    const handleSendMessage = async (message: string) => {
        // Typing while a reply streams no longer waits on it. The message joins a
        // queue and is sent once the current exchange finishes, so the transcript
        // stays in the order it was written rather than interleaving two replies.
        if (isLoading || activeStream || drainingRef.current) {
            pendingRef.current = [...pendingRef.current, message];
            setPending(pendingRef.current);
            return;
        }
        await processMessage(message, chats);
    };

    /**
     * Sends the next queued message once nothing is in flight.
     *
     * Driven by an effect rather than chained onto the end of `startStreaming`, so
     * a failed reply drains the queue exactly like a successful one — an error
     * shouldn't strand everything typed after it.
     */
    useEffect(() => {
        if (drainingRef.current || isLoading || activeStream) return;
        if (pendingRef.current.length === 0) return;

        const [next, ...rest] = pendingRef.current;
        pendingRef.current = rest;
        setPending(rest);
        drainingRef.current = true;
        processMessage(next, chatsRef.current).finally(() => {
            drainingRef.current = false;
        });
    }, [isLoading, activeStream, pending]);

    const handleEdit = async (timestamp: string, newContent: string) => {
        if (!sessionId || isLoading) return;

        try {
            setIsLoading(true);

            // Delete messages from DB
            await deleteMessagesAfter(sessionId, timestamp);

            // Find base history before the edited message
            const msgIndex = chats.findIndex(c => c.timestamp === timestamp);
            if (msgIndex === -1) {
                setIsLoading(false);
                return;
            }

            const historyBefore = chats.slice(0, msgIndex);

            // Process the edited message using the clean history
            await processMessage(newContent, historyBefore);

        } catch (error) {
            console.error('Error in editing:', error);
            setIsLoading(false);
        }
    };

    const handleDeleteMessage = async (timestamp: string) => {
        if (!sessionId || isLoading) return;

        const msgIndex = chats.findIndex(c => c.timestamp === timestamp);
        if (msgIndex === -1) return;

        try {
            // Truncate this message and everything after it. deleteMessagesAfter
            // removes messages with timestamp greater than the given one, so we
            // anchor on the previous message (or a min sentinel for the first).
            const anchorTs = msgIndex > 0
                ? chats[msgIndex - 1].timestamp ?? "0000-01-01T00:00:00.000Z"
                : "0000-01-01T00:00:00.000Z";

            await deleteMessagesAfter(sessionId, anchorTs);
            setChats(chats.slice(0, msgIndex));

            if (onSessionChange) {
                onSessionChange();
            }
        } catch (error) {
            console.error('Error deleting message:', error);
        }
    };

    const handleRegenerate = async (timestamp: string) => {
        if (!sessionId || isLoading) return;

        try {
            setIsLoading(true);

            // Delete messages from DB
            await deleteMessagesAfter(sessionId, timestamp);

            // Update local state: find the message index and keep everything before it
            const msgIndex = chats.findIndex(c => c.timestamp === timestamp);
            if (msgIndex === -1) {
                setIsLoading(false);
                return;
            }

            const historyBefore = chats.slice(0, msgIndex);

            // Don't add empty message yet - wait for stream
            setChats(historyBefore);

            await startStreaming(historyBefore, sessionId);

        } catch (error) {
            console.error('Error in regeneration:', error);
            setIsLoading(false);
        }
    };

    /**
     * Forks this chat at the given reply into a new one and opens it. The copy
     * happens in SQLite rather than by replaying the messages through here, so a
     * long conversation doesn't cross the bridge twice and can't half-copy.
     */
    const handleBranch = async (timestamp: string) => {
        if (!sessionId) return;
        try {
            const branch = await branchSession(sessionId, timestamp);
            onSessionChange?.();          // sidebar picks up the new chat
            onSessionCreate?.(branch.id); // and we follow the user into it
        } catch (error) {
            console.error('Error branching chat:', error);
        }
    };

    /**
     * Stops the reply in flight. The tokens already streamed are kept — the backend
     * returns them as a normal completion, so the partial answer saves like any
     * other rather than being thrown away for having been interrupted.
     */
    /**
     * Identity-stable wrappers for the callbacks handed to each message row.
     *
     * `memo` on those rows only helps if their props stop changing, and these
     * handlers are redeclared on every render — so without this every token still
     * re-rendered every message. Routed through a ref rather than `useCallback`
     * because they close over most of this component's state; a dep list would be
     * either wrong today or wrong after the next edit, and a stale closure here
     * edits the wrong message.
     */
    const rowHandlers = useRef({ handleEdit, handleDeleteMessage, handleRegenerate, handleBranch });
    rowHandlers.current = { handleEdit, handleDeleteMessage, handleRegenerate, handleBranch };
    const onEditRow = useCallback((t: string, c: string) => rowHandlers.current.handleEdit(t, c), []);
    const onDeleteRow = useCallback((t: string) => rowHandlers.current.handleDeleteMessage(t), []);
    const onRegenerateRow = useCallback((t: string) => rowHandlers.current.handleRegenerate(t), []);
    const onBranchRow = useCallback((t: string) => rowHandlers.current.handleBranch(t), []);

    const handleStop = () => {
        const id = activeStreamIdRef.current;
        if (id) void stopMessage(id);
    };

    /**
     * The MCP servers whose tools this send may use: the ones currently running —
     * "running" *is* "on" now that the MCP page has a single connect/disconnect
     * toggle (a server the user turned on has already passed the trust prompt) —
     * but only if the model can take tools at all. Offline returns nothing (the
     * backend also suppresses tools; skipping the work is cheaper). The running
     * check comes first and short-circuits, so an ordinary no-MCP chat is cheap.
     */
    const resolveEnabledServers = useCallback(async (): Promise<string[]> => {
        if (settings.offlineMode) return [];

        let running: string[];
        try {
            running = await invoke<string[]>('mcp_running_servers');
        } catch {
            return [];
        }
        if (running.length === 0) return [];

        // Offer tools only to a model that can take them. `InstalledModel` carries no
        // capabilities, so the tools flag comes from list_ollama_models.
        try {
            const summary = (await listModels()).find(m => m.name === model);
            if (!summary || !canUseTools(summary)) return [];
        } catch {
            return [];
        }

        return running;
    }, [settings.offlineMode, model, listModels]);

    /**
     * Deliver the user's decision for a pending tool call. Optimistically drops the
     * approval buttons the instant the click registers (`markToolRunning`); the
     * result event fills in the outcome a moment later. Keyed on the viewed session,
     * which is the one whose stream is showing the prompt.
     */
    const handleApprove = useCallback((callId: string, decision: ToolDecision) => {
        if (sessionId) markToolRunning(sessionId, callId);
        void invoke('mcp_approve_tool', { callId, decision })
            .catch(err => console.error('Failed to approve tool call:', err));
    }, [sessionId]);

    /** History as the model should see it: answers only, no reasoning. */
    const historyForModel = (history: ChatMessage[]) =>
        history
            .map(c => ({
                role: c.role,
                content: c.role === 'assistant' ? splitThinking(c.content).answer : c.content,
            }))
            .filter(c => c.content.trim() !== '');

    const startStreaming = async (history: ChatMessage[], currentSessionId: string) => {
        // Setup streaming listener
        let fullResponse = "";
        let stats: MessageStats = {};
        // Scopes both listeners to this request, so a second chat started while
        // this one is still generating can't feed its tokens into this response.
        const streamId = crypto.randomUUID();
        activeStreamIdRef.current = streamId;
        beginStream(currentSessionId);
        const unlistenDone = await listen<ChatDonePayload | null>('chat-done', (event) => {
            const payload = event.payload;
            if (!payload || payload.stream_id !== streamId) return;
            stats = {
                // Ollama reports nanoseconds.
                duration_ms: payload.total_duration != null ? Math.round(payload.total_duration / 1e6) : null,
                prompt_tokens: payload.prompt_eval_count ?? null,
                eval_tokens: payload.eval_count ?? null,
            };
        });
        const unlisten = await listen<ChatTokenPayload>('chat-token', (event) => {
            if (event.payload?.stream_id !== streamId) return;
            const token = event.payload.token;

            // Accumulated unconditionally. This used to sit behind a session
            // check, so switching chats mid-stream dropped the remaining tokens
            // from the response itself — not just from the view — and the message
            // was saved cut off at the moment you switched.
            fullResponse += token;

            // The store is the single home for in-flight text: it survives this
            // component unmounting, so the reply keeps rendering (and keeps its
            // counters) whichever page you happen to be on.
            appendToken(currentSessionId, token);
        });

        // Tool activity is kept in insertion order for the save, and mirrored into
        // the store for the live cards. Keyed by call id so the result finds its call.
        const toolInteractions = new Map<string, ToolInteraction>();
        const unlistenToolCall = await listen<ChatToolCallPayload>('chat-tool-call', (event) => {
            const p = event.payload;
            if (!p || p.stream_id !== streamId) return;
            toolInteractions.set(p.call_id, {
                callId: p.call_id,
                tool: p.tool,
                server: p.server,
                toolName: p.tool_name,
                arguments: p.arguments,
                result: "",
                isError: false,
                // A pre-approved call carries no prompt, so it is already 'auto'.
                decision: p.needs_approval ? "" : "auto",
            });
            appendToolCall(
                currentSessionId,
                { callId: p.call_id, tool: p.tool, server: p.server, toolName: p.tool_name, arguments: p.arguments },
                p.needs_approval,
            );
        });
        const unlistenToolResult = await listen<ChatToolResultPayload>('chat-tool-result', (event) => {
            const p = event.payload;
            if (!p || p.stream_id !== streamId) return;
            const existing = toolInteractions.get(p.call_id);
            if (existing) {
                existing.result = p.content;
                existing.isError = p.is_error;
                existing.decision = p.decision;
            } else {
                // A result with no prior call event (shouldn't happen, but don't
                // lose it) — record what the result carries.
                toolInteractions.set(p.call_id, {
                    callId: p.call_id, tool: p.tool, server: "", toolName: p.tool,
                    arguments: undefined, result: p.content, isError: p.is_error, decision: p.decision,
                });
            }
            resolveToolCall(currentSessionId, p.call_id, { result: p.content, isError: p.is_error, decision: p.decision });
        });

        unlistenRef.current = () => {
            unlisten();
            unlistenDone();
            unlistenToolCall();
            unlistenToolResult();
        };

        try {
            // Start stream (awaits until stream is done)
            if (factsReady.current) await factsReady.current;
            const derived = resolveFrom(cachedFacts(model)) || numCtx;
            // While the model is unchanged the chat keeps the terms its transcript was
            // written under; a new chat — or a switch to a different model — derives
            // and records fresh terms for the model now in use, so switching to a
            // bigger-context model actually widens the window.
            const locked = sessionCtx !== undefined && sessionModel === model;
            const sendCtx = locked ? sessionCtx : derived;
            if (!locked) {
                void recordSessionContext(currentSessionId, sendCtx, model);
                setSessionCtx(sendCtx);
                setSessionModel(model);
            }
            const enabledServers = await resolveEnabledServers();
            await streamMessage(
                model,
                // Reasoning is kept for the reader, not resent to the model.
                //
                // It lives inside the assistant message's content, so sending that
                // verbatim fed every past thought back into the prompt. Measured on
                // qwen3.5:4b-mlx: one answer of ~1,943 tokens carried ~2,204 tokens
                // of reasoning, so each turn cost more than twice what the
                // conversation actually contains. Chat templates drop prior
                // reasoning for the same reason — models are trained on histories
                // without it.
                //
                // An assistant turn that was *only* reasoning (stopped mid-think)
                // reduces to nothing and is dropped rather than sent as an empty
                // turn.
                historyForModel(history),
                sendCtx,
                settings.keepAliveSeconds,
                streamId,
                enabledServers,
            );

            const toolCalls = Array.from(toolInteractions.values());

            // Nothing generated means nothing to keep. Stopping before the first
            // token used to save the empty string anyway, leaving a blank assistant
            // turn in the transcript and a zero-length row in the database — there
            // is one in there from exactly this. A reply that produced *some* text
            // is still saved: the user chose to stop it, and what arrived is a real
            // partial answer, not a failure. Tool activity counts as content too —
            // a turn that only ran tools is a real turn worth keeping.
            if (!fullResponse && toolCalls.length === 0) {
                if (onSessionChange) onSessionChange();
                return;
            }

            // Save AI response to database, with any tool activity attached.
            const savedMsg = await saveMessage(currentSessionId, 'assistant', fullResponse, stats, toolCalls);

            // Raised here rather than from a global `chat-done` listener because this
            // is the only place that has the reply itself — the event carries a stream
            // id and token counts, not content. It also survives the page unmounting,
            // for the same reason the stream's teardown does: the whole async function
            // keeps running, which is exactly the case worth notifying about, since
            // you left.
            void pushNotify(
                settings.pushNotifications,
                "reply",
                `Reply from ${model}`,
                replyPreview(fullResponse),
            );

            // If the user navigated away mid-stream, the ChatPage now on screen is
            // a different instance that never saw these tokens. Tell it to re-read
            // the conversation so the finished reply appears instead of nothing.
            window.dispatchEvent(new CustomEvent(STREAM_COMPLETE_EVENT, {
                detail: { sessionId: currentSessionId },
            }));

            // Appended, not patched. While streaming, the reply lives only in the
            // store — `chats` holds persisted history — so there is no placeholder
            // here to update; the finished message joins the history now.
            //
            // Guarded on the timestamp because the event above may have already
            // triggered a reload from the database. That reload replaces the whole
            // array, so if it lands first an unguarded append would add a second
            // copy of this reply and nothing would correct it.
            setChats(prev => prev.some(c => c.timestamp === savedMsg.timestamp) ? prev : [...prev, {
                role: 'assistant',
                content: fullResponse,
                timestamp: savedMsg.timestamp,
                tool_calls: toolCalls.length ? toolCalls : undefined,
                ...stats,
            }]);

            // Notify parent that session was updated
            if (onSessionChange) {
                onSessionChange();
            }
        } catch (error) {
            console.error('Error in streaming:', error);
            const detail = String((error as Error)?.message ?? error).replace(/^Error:\s*/, "");
            void pushNotify(
                settings.pushNotifications,
                "error",
                "That reply didn't finish",
                detail.slice(0, 160),
            );
            const errorMessage: ChatMessage = {
                role: 'assistant',
                // The engine's own words as well as the advice. A single hardcoded
                // line threw away the only thing that distinguishes an engine that
                // isn't running from a model that can't chat from a context that
                // wouldn't load — and that is the part the user can act on.
                content: `Sorry, I encountered an error. Please make sure the engine is running and try again.\n\n${detail}`,
            };
            // The partial reply lived in the store, which the `finally` clears, so
            // there's nothing to replace — the error simply takes its place.
            setChats(prev => [...prev, errorMessage]);
        } finally {
            if (unlistenRef.current) {
                unlistenRef.current();
                unlistenRef.current = null;
            }
            setIsLoading(false);
            activeStreamIdRef.current = null;
            // Cleared last, after the saved message is in `chats`, so the finished
            // reply replaces the streaming one without a frame of neither.
            endStream(currentSessionId);
        }
    };

    const processMessage = async (message: string, currentHistory: ChatMessage[]) => {
        let currentSessionId = sessionId;
        setIsLoading(true);

        try {
            if (!currentSessionId) {
                const title = message.slice(0, 30) + (message.length > 30 ? '...' : '');
                const newSession = await createSession(title);
                currentSessionId = newSession.id;

                if (onSessionCreate) {
                    onSessionCreate(newSession.id);
                }
            }

            // Save user message to database
            const savedUserMsg = await saveMessage(currentSessionId, 'user', message);
            const userMessage: ChatMessage = {
                role: 'user',
                content: message,
                timestamp: savedUserMsg.timestamp
            };

            // Add messages to state precisely
            const updatedChats = [...currentHistory, userMessage];
            setChats(updatedChats);

            await startStreaming(updatedChats, currentSessionId);

        } catch (error) {
            console.error('Error in message processing:', error);
            setIsLoading(false);
        }
    };

    if (chats.length === 0 && !isLoading && !activeStream) {
        return (
            <div className="flex flex-col items-center justify-center h-full w-full gap-6 px-4">
                <p className="font-normal text-[24px] leading-[32px] text-fg text-center tracking-[-0.4px] max-w-[640px] w-full">
                    {greeting}
                </p>
                <div className="w-full max-w-[640px]">
                    <ChatInput
                        onSendMessage={handleSendMessage}
                        disabled={isLoading}
                        variant="hero"
                        model={model}
                        onModelSelect={onModelSelect}
                        onBrowseModels={onBrowseModels}
                        contextLimit={effectiveCtx}
                        contextAffordableNow={ctxExceedsToday?.now}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full w-full">
            {/* Conversation — 640px column, centered */}
            <div
                ref={chatContainerRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto overflow-x-hidden w-full no-scrollbar chat-fade"
                style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}
            >
                {/* select-text re-enables selection just for the transcript — the rest
                    of the app is select-none so the window drags and doesn't select
                    chrome (see index.css). Copy a reply, not the sidebar. */}
                <div className="max-w-[640px] mx-auto flex flex-col gap-4 px-4 py-8 select-text">
                    {chats.map((chat, index) => {
                        const messageKey = chat.timestamp || `msg-${index}`;

                        return chat.role === 'assistant' ? (
                            <AIChatView
                                key={messageKey}
                                message={chat.content}
                                timestamp={chat.timestamp}
                                stats={chat}
                                toolCalls={chat.tool_calls}
                                onRegenerate={onRegenerateRow}
                                onBranch={onBranchRow}
                            />
                        ) : (
                            <HumanChatView
                                key={messageKey}
                                message={chat.content}
                                timestamp={chat.timestamp}
                                onEdit={onEditRow}
                                onDelete={onDeleteRow}
                            />
                        );
                    })}
                    {/* The reply being generated, rendered from the store rather
                        than from `chats`, so it survives this component unmounting
                        while you're on another page. */}
                    {activeStream && (activeStream.content || activeStream.toolCalls.length > 0) && (
                        <AIChatView
                            message={activeStream.content}
                            toolCalls={activeStream.toolCalls}
                            onApprove={handleApprove}
                            isStreaming
                        />
                    )}

                    {/* Queued while the current reply finishes. Shown rather than
                        swallowed so it's obvious the message was taken and where it
                        sits in the order — muted because nothing has answered it. */}
                    {pending.map((text, i) => (
                        <div key={`pending-${i}`} className="opacity-50">
                            <HumanChatView message={text} />
                        </div>
                    ))}

                    {/* Live status. The dot grid runs only until the first token
                        lands — after that the text itself is the progress — but the
                        counters stay for the whole response, so the row outlives the
                        animation. Driven by the store too, which is the actual fix:
                        this used to disappear the moment you navigated away, which
                        read as the reply having stopped when it hadn't. */}
                    {activeStream && (
                        <div className="flex items-center gap-2 w-full animate-in fade-in duration-300">
                            {!activeStream.content && <LoadingGrid />}
                            <GenerationStatus
                                startedAt={activeStream.startedAt}
                                tokenCount={activeStream.tokens}

                            />
                        </div>
                    )}
                </div>
            </div>

            {/* Bottom input — hero style with model picker, 640px centered */}
            <div className="w-full">
                {/* px-1 rather than px-4, so the composer's *content* box is 600px:
                    640 max − 8 wrapper padding = 632 outer, − 32 of the card's own
                    p-4 = 600. Widening the card instead of trimming its padding
                    keeps the text from hugging the rounded edge. */}
                <div className="max-w-[640px] mx-auto px-1 pb-4">
                    <ChatInput
                        onSendMessage={handleSendMessage}
                        variant="hero"
                        placeholder="Send message"
                        model={model}
                        onModelSelect={onModelSelect}
                        onBrowseModels={onBrowseModels}
                        contextUsed={contextUsed}
                        contextLimit={effectiveCtx}
                        contextAffordableNow={ctxExceedsToday?.now}
                        contextNotice={pendingNotice}
                        onAcknowledgeContext={acknowledgeContext}
                        onStop={isLoading || activeStream ? handleStop : undefined}
                    />
                </div>
            </div>
        </div>
    );
}
