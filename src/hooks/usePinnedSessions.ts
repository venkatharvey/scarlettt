import { useCallback, useState } from "react";

const STORAGE_KEY = "scarlettt_pinned_sessions";

/** Hard ceiling on pinned chats — past this the user has to unpin something. */
export const MAX_PINNED_SESSIONS = 10;

function readPinned(): string[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

export function usePinnedSessions() {
    const [pinnedIds, setPinnedIds] = useState<string[]>(() => readPinned());

    const togglePin = useCallback((sessionId: string) => {
        setPinnedIds(prev => {
            if (!prev.includes(sessionId) && prev.length >= MAX_PINNED_SESSIONS) return prev;
            const next = prev.includes(sessionId)
                ? prev.filter(id => id !== sessionId)
                : [...prev, sessionId];
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            return next;
        });
    }, []);

    const isPinned = useCallback((sessionId: string) => pinnedIds.includes(sessionId), [pinnedIds]);

    return {
        pinnedIds,
        togglePin,
        isPinned,
        isPinLimitReached: pinnedIds.length >= MAX_PINNED_SESSIONS,
    };
}
