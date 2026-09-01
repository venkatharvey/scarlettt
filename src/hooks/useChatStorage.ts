import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';

export interface ChatSession {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
    /** Set when the chat lives inside a project; null/undefined means loose. */
    project_id?: string | null;
    /** Id of the chat this was branched from — absent for an ordinary chat. */
    branched_from?: string | null;
    /**
     * The context length this chat's replies were generated under, fixed by the
     * first reply. Absent on chats that predate the column, or that have no reply
     * yet — both genuinely unknown, which is why it isn't backfilled.
     */
    num_ctx?: number | null;
    /** The model those replies came from — a context length means little alone. */
    model?: string | null;
}

export interface MessageStats {
    duration_ms?: number | null;
    prompt_tokens?: number | null;
    eval_tokens?: number | null;
}

/**
 * One tool call made during an assistant turn, with its outcome. Stored as a JSON
 * array attached to the assistant message (never as separate rows), so the tool
 * cards stay grouped with the reply that produced them. The frontend both writes
 * this (from the tool events) and reads it back, so the shape is defined here.
 */
export interface ToolInteraction {
    /** The one-time id the backend assigned this call. */
    callId: string;
    /** The namespaced name the model called (`serverid__tool`). */
    tool: string;
    /** The server id, and the server-local tool name, for display. */
    server: string;
    toolName: string;
    /** The arguments the model produced. */
    arguments: unknown;
    /** The flattened result text fed back to the model (or a blocked/denied note). */
    result: string;
    isError: boolean;
    /** How it was resolved: allow-once | allow-session | auto | deny | offline. */
    decision: string;
}

export interface StoredMessage extends MessageStats {
    id: string;
    session_id: string;
    role: string;
    content: string;
    timestamp: string;
    /** Present only on assistant turns that called MCP tools. */
    tool_calls?: ToolInteraction[] | null;
}

export interface SearchResult {
    session_id: string;
    title: string;
    updated_at: string;
    matching_content: string;
}

export const useChatStorage = () => {
    const createSession = useCallback(async (title?: string): Promise<ChatSession> => {
        try {
            const session = await invoke<ChatSession>('create_chat_session', { title });
            return session;
        } catch (error) {
            console.error('Error creating chat session:', error);
            throw error;
        }
    }, []);

    /**
     * Forks the conversation at `timestamp` into a new chat, keeping that message
     * and everything before it. The source chat is not modified.
     */
    const branchSession = useCallback(async (sessionId: string, timestamp: string): Promise<ChatSession> => {
        try {
            return await invoke<ChatSession>('branch_chat_session', { sessionId, timestamp });
        } catch (error) {
            console.error('Error branching chat session:', error);
            throw error;
        }
    }, []);

    /**
     * Fixes the terms this chat's replies are generated under. First write wins —
     * the backend ignores later calls, so a chat's context can't drift as free
     * memory moves between sessions.
     */
    const recordSessionContext = useCallback(async (sessionId: string, numCtx: number, model: string): Promise<void> => {
        try {
            await invoke('record_session_context', { sessionId, numCtx, model });
        } catch (error) {
            console.error('Error recording session context:', error);
        }
    }, []);

    const getSessions = useCallback(async (): Promise<ChatSession[]> => {
        try {
            const sessions = await invoke<ChatSession[]>('get_chat_sessions');
            return sessions;
        } catch (error) {
            console.error('Error getting chat sessions:', error);
            throw error;
        }
    }, []);

    const getMessages = useCallback(async (sessionId: string): Promise<StoredMessage[]> => {
        try {
            const messages = await invoke<StoredMessage[]>('get_chat_messages', { sessionId });
            return messages;
        } catch (error) {
            console.error('Error getting messages:', error);
            throw error;
        }
    }, []);

    const saveMessage = useCallback(async (
        sessionId: string,
        role: string,
        content: string,
        stats?: MessageStats,
        toolCalls?: ToolInteraction[]
    ): Promise<StoredMessage> => {
        try {
            const message = await invoke<StoredMessage>('save_message', {
                sessionId,
                role,
                content,
                durationMs: stats?.duration_ms ?? null,
                promptTokens: stats?.prompt_tokens ?? null,
                evalTokens: stats?.eval_tokens ?? null,
                // Only assistant turns that called tools carry this; null otherwise.
                toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
            });
            return message;
        } catch (error) {
            console.error('Error saving message:', error);
            throw error;
        }
    }, []);

    const renameSession = useCallback(async (sessionId: string, title: string): Promise<void> => {
        try {
            await invoke('rename_chat_session', { sessionId, title });
        } catch (error) {
            console.error('Error renaming session:', error);
            throw error;
        }
    }, []);

    const deleteSession = useCallback(async (sessionId: string): Promise<void> => {
        try {
            await invoke('delete_chat_session', { sessionId });
        } catch (error) {
            console.error('Error deleting session:', error);
            throw error;
        }
    }, []);

    /** Semantic search over message content — returns one SearchResult per session
     *  (same shape as `searchChats`), or [] when the embedding model isn't ready. */
    const searchSimilar = useCallback(async (query: string, limit: number = 20): Promise<SearchResult[]> => {
        try {
            return await invoke<SearchResult[]>('search_similar_messages', { query, limit });
        } catch (error) {
            console.error('Error searching similar messages:', error);
            return [];
        }
    }, []);

    const searchChats = useCallback(async (query: string): Promise<SearchResult[]> => {
        try {
            const results = await invoke<SearchResult[]>('search_chats', { query });
            return results;
        } catch (error) {
            console.error('Error searching chats:', error);
            return [];
        }
    }, []);

    /**
     * `role` and `content` are all the backend needs — `import_session` mints the
     * id and stamps the timestamp itself, and the Rust struct marks the rest
     * `#[serde(default)]`. Demanding a full StoredMessage here meant callers had
     * to invent an id and a session_id that would be thrown away.
     */
    const importChat = useCallback(async (
        title: string,
        messages: Array<Pick<StoredMessage, 'role' | 'content'> & Partial<StoredMessage>>,
    ): Promise<ChatSession> => {
        try {
            const session = await invoke<ChatSession>('import_chat', { title, messages });
            return session;
        } catch (error) {
            console.error('Error importing chat:', error);
            throw error;
        }
    }, []);

    const appendMessages = useCallback(async (sessionId: string, messages: Partial<StoredMessage>[]): Promise<void> => {
        try {
            await invoke('append_messages', { sessionId, messages });
        } catch (error) {
            console.error('Error appending messages:', error);
            throw error;
        }
    }, []);

    const deleteMessagesAfter = useCallback(async (sessionId: string, timestamp: string): Promise<void> => {
        try {
            await invoke('delete_messages_after', { sessionId, timestamp });
        } catch (error) {
            console.error('Error deleting messages:', error);
            throw error;
        }
    }, []);

    return {
        createSession,
        branchSession,
        getSessions,
        recordSessionContext,
        getMessages,
        saveMessage,
        renameSession,
        deleteSession,
        searchSimilar,
        searchChats,
        importChat,
        appendMessages,
        deleteMessagesAfter,
    };
};
