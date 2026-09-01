import { useEffect, useMemo, useRef, useState } from "react";
import { NO_AUTOCORRECT } from "../../inputProps";
import { useChatStorage, ChatSession, SearchResult } from "../../hooks/useChatStorage";
import SearchGlyph from "../../svg/SearchGlyph";
import ArrowSplitGlyph from "../../svg/chat/ArrowSplitGlyph";
import KeyboardArrowDown from "../../svg/KeyboardArrowDown";
import { formatRelativeTime } from "../chat/relativeTime";

type SortKey = "recent" | "oldest" | "alpha";

const SORT_LABEL: Record<SortKey, string> = {
    recent: "Recently updated",
    oldest: "Oldest first",
    alpha: "A–Z",
};

/** Bold the matched run so it's obvious *why* a row is in the results. */
function Highlighted({ text, query }: { text: string; query: string }) {
    const term = query.trim();
    if (!term) return <>{text}</>;

    // Escaped: a query of "c++" or "(" is a user's search, not a pattern.
    const parts = text.split(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
    return (
        <>
            {parts.map((part, i) =>
                part.toLowerCase() === term.toLowerCase()
                    ? <mark key={i} className="bg-transparent font-semibold text-fg">{part}</mark>
                    : <span key={i}>{part}</span>
            )}
        </>
    );
}

interface SearchPageProps {
    onSessionSelect: (sessionId: string) => void;
    sessionsRefreshTrigger?: number;
}

export default function SearchPage({ onSessionSelect, sessionsRefreshTrigger }: SearchPageProps) {
    const { getSessions, searchChats, searchSimilar } = useChatStorage();

    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [query, setQuery] = useState("");
    const [sortBy, setSortBy] = useState<SortKey>("recent");
    const [sortOpen, setSortOpen] = useState(false);
    /** Content matches from the database — titles are matched locally. */
    const [contentHits, setContentHits] = useState<SearchResult[]>([]);
    /** Matches by meaning (semantic), one per session — empty if the embedding
     *  model isn't ready yet, so search still works on keyword alone. */
    const [semanticHits, setSemanticHits] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        getSessions().then(setSessions).catch(() => {});
    }, [sessionsRefreshTrigger]);

    useEffect(() => { inputRef.current?.focus(); }, []);

    // Two sources, deliberately. Titles filter locally so every keystroke is
    // instant; message bodies need the database, which is debounced because it
    // reads every message. Waiting on the round trip for a title match would make
    // typing feel laggy for the commonest case.
    useEffect(() => {
        const term = query.trim();
        if (!term) {
            setContentHits([]);
            setSemanticHits([]);
            setIsSearching(false);
            return;
        }
        setIsSearching(true);
        const timer = window.setTimeout(async () => {
            try {
                // Keyword (exact) and semantic (by meaning) in parallel. Semantic
                // returns [] when the embedding model isn't ready, so this degrades to
                // keyword-only rather than failing.
                const [keyword, semantic] = await Promise.all([
                    searchChats(term),
                    searchSimilar(term),
                ]);
                setContentHits(keyword);
                setSemanticHits(semantic);
            } finally {
                setIsSearching(false);
            }
        }, 250);
        return () => window.clearTimeout(timer);
    }, [query, searchChats, searchSimilar]);

    // Keyword snippets take precedence (they contain the term, so they highlight);
    // semantic snippets fill in for sessions matched only by meaning.
    const snippets = useMemo(() => {
        const map = new Map<string, string>();
        for (const hit of semanticHits) map.set(hit.session_id, hit.matching_content);
        for (const hit of contentHits) map.set(hit.session_id, hit.matching_content);
        return map;
    }, [contentHits, semanticHits]);

    const matches = useMemo(() => {
        const term = query.trim().toLowerCase();
        const byContent = new Set([
            ...contentHits.map(h => h.session_id),
            ...semanticHits.map(h => h.session_id),
        ]);
        const filtered = term
            ? sessions.filter(s => s.title.toLowerCase().includes(term) || byContent.has(s.id))
            : sessions;

        return [...filtered].sort((a, b) => {
            if (sortBy === "alpha") return a.title.localeCompare(b.title);
            const cmp = a.updated_at.localeCompare(b.updated_at);
            return sortBy === "oldest" ? cmp : -cmp;
        });
    }, [sessions, contentHits, semanticHits, query, sortBy]);

    const total = matches.length;

    const Row = ({ session }: { session: ChatSession }) => (
        <div
            className="flex flex-col gap-0.5 p-2 rounded cursor-pointer transition-colors hover:bg-hover/70"
            onClick={() => onSessionSelect(session.id)}
        >
            <div className="flex items-center gap-2 min-w-0">
                {session.branched_from && (
                    <span className="flex-shrink-0" title="Branched from another chat">
                        <ArrowSplitGlyph size={14} color="rgb(var(--fg-muted))" />
                    </span>
                )}
                <p className="flex-1 min-w-0 text-sm leading-[18px] text-fg truncate">
                    <Highlighted text={session.title} query={query} />
                </p>
                <span className="flex-shrink-0 text-xs leading-4 text-fg-faint">
                    {formatRelativeTime(session.updated_at)}
                </span>
            </div>
            {/* Only shown when the match came from the body, so the row explains
                itself when the title alone doesn't contain the term. */}
            {snippets.get(session.id) && (
                <p className="text-xs leading-4 text-fg-muted line-clamp-2 break-words">
                    {snippets.get(session.id)}
                </p>
            )}
        </div>
    );

    return (
        <div className="flex-1 overflow-y-auto no-scrollbar" style={{ msOverflowStyle: "none", scrollbarWidth: "none" }}>
            <div className="max-w-[640px] mx-auto flex flex-col gap-8 px-4 py-8">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <SearchGlyph size={16} color="rgb(var(--fg))" />
                        <h1 className="text-sm leading-[18px] text-fg">Search chats</h1>
                    </div>
                    <p className="text-xs leading-4 text-fg-muted">
                        Searches titles and everything said in them — by keyword and by meaning — across every
                        chat wherever it's filed. Everything runs on this machine; nothing is sent anywhere.
                    </p>
                </div>

                <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                        <input
                            {...NO_AUTOCORRECT}
                            ref={inputRef}
                            type="text"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder="Search chats"
                            className="w-full px-3 py-2 text-sm leading-[18px] text-fg bg-card rounded-lg border border-line focus:outline-none focus:border-fg-faint transition-colors placeholder-fg-muted"
                        />
                        {isSearching && (
                            <div className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 border-2 border-line-strong border-t-fg-secondary rounded-full animate-spin" />
                        )}
                    </div>

                    <div className="relative flex-shrink-0">
                        <button
                            className="flex items-center gap-1 whitespace-nowrap px-3 py-2 rounded-lg bg-card border border-line text-sm leading-[18px] text-fg hover:border-fg-faint transition-colors"
                            onClick={() => setSortOpen(open => !open)}
                        >
                            {SORT_LABEL[sortBy]}
                            <span className={`transition-transform ${sortOpen ? "rotate-180" : ""}`}>
                                <KeyboardArrowDown size={14} color="rgb(var(--fg-muted))" />
                            </span>
                        </button>
                        {sortOpen && (
                            <>
                                {/* Catches the next click anywhere so the menu closes
                                    without a document-level listener. */}
                                <div className="fixed inset-0 z-10" onClick={() => setSortOpen(false)} />
                                <div className="absolute right-0 mt-1 z-20 w-[168px] bg-card rounded-lg shadow-lg border border-line py-1">
                                    {(Object.keys(SORT_LABEL) as SortKey[]).map(key => (
                                        <button
                                            key={key}
                                            className={`w-full text-left px-3 py-1.5 text-sm hover:bg-hover ${
                                                sortBy === key ? "text-fg" : "text-fg-secondary"
                                            }`}
                                            onClick={() => { setSortBy(key); setSortOpen(false); }}
                                        >
                                            {SORT_LABEL[key]}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {total === 0 ? (
                    <p className="p-2 text-sm leading-[18px] text-fg-faint">
                        {query.trim() ? `No chats match "${query.trim()}".` : "No chats yet."}
                    </p>
                ) : (
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2 px-2">
                            <p className="text-xs leading-4 text-fg-secondary">All chats</p>
                            <span className="text-xs leading-4 text-fg-faint">{total}</span>
                        </div>
                        <div className="flex flex-col">
                            {matches.map(s => <Row key={s.id} session={s} />)}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
