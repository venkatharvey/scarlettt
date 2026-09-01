import { useState, useEffect, useRef } from 'react';
import { NO_AUTOCORRECT } from "../../../inputProps";
import { useChatStorage, SearchResult } from '../../../hooks/useChatStorage';
// import Search from '../../../svg/Search'; // Removing search icon from import if not used in the exact design or using a different one

interface SearchModalProps {
    isOpen: boolean;
    onClose: () => void;
    onResultSelect: (sessionId: string) => void;
}

export default function SearchModal({ isOpen, onClose, onResultSelect }: SearchModalProps) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [recentChats, setRecentChats] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const { searchChats, getSessions } = useChatStorage();
    const inputRef = useRef<HTMLInputElement>(null);
    const modalRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (isOpen) {
            if (inputRef.current) {
                inputRef.current.focus();
            }
            loadRecentChats();
        }
    }, [isOpen]);

    const loadRecentChats = async () => {
        try {
            const sessions = await getSessions();
            // Map sessions to SearchResult format and take top 5
            const recent = sessions.slice(0, 5).map(session => ({
                session_id: session.id,
                title: session.title,
                updated_at: session.updated_at,
                matching_content: ''
            }));
            setRecentChats(recent);
            // Initialize results with recent chats
            setResults(recent);
        } catch (error) {
            console.error("Failed to load recent chats", error);
        }
    };

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
                onClose();
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            document.addEventListener('keydown', handleEscape);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [isOpen, onClose]);

    useEffect(() => {
        if (query.trim().length === 0) {
            // Show recent chats when query is empty
            setResults(recentChats);
            return;
        }

        const timer = setTimeout(async () => {
            setIsSearching(true);
            const searchResults = await searchChats(query);
            // Limit results if needed, e.g., to 5 to match design compactness
            setResults(searchResults.slice(0, 5));
            setIsSearching(false);
        }, 300);

        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, recentChats]); // Added recentChats dependency so it updates if they load late

    const handleResultClick = (sessionId: string) => {
        onResultSelect(sessionId);
        onClose();
        setQuery('');
        // setResults([]); // We want recent chats next time, so maybe leave it or reset to recent? 
        // loadRecentChats will reset it on next open.
    };

    // Helper to highlight matching text
    const HighlightedText = ({ text, highlight }: { text: string, highlight: string }) => {
        if (!highlight.trim()) {
            return <span className="text-fg">{text}</span>;
        }

        const regex = new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        const parts = text.split(regex);

        return (
            <span>
                {parts.map((part, i) => (
                    regex.test(part) ? (
                        <span key={i} className="font-semibold text-fg">{part}</span>
                    ) : (
                        <span key={i} className="text-fg-secondary">{part}</span>
                    )
                ))}
            </span>
        );
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4 z-[100]">
            {/* Same shell as the sidebar card: #fafafa, 16px radius, p-2. */}
            <div
                ref={modalRef}
                className="bg-raised rounded-2xl shadow-lg w-[600px] overflow-hidden flex flex-col p-2 max-h-[80vh] mb-[15vh] border border-line"
            >
                {/* Search Input Area */}
                <div className="flex items-center bg-card rounded-lg px-3 py-2 mb-2 border border-line focus-within:border-fg-faint transition-colors">
                    <input
                        {...NO_AUTOCORRECT}
                        ref={inputRef}
                        type="text"
                        placeholder="Search chats"
                        className="flex-1 bg-transparent text-sm leading-[18px] text-fg outline-none placeholder-fg-muted"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    {isSearching && (
                        <div className="w-3.5 h-3.5 border-2 border-line-strong border-t-fg-secondary rounded-full animate-spin ml-2" />
                    )}
                </div>

                {/* Results List — sidebar row treatment */}
                <div className="flex flex-col gap-2 overflow-y-auto no-scrollbar" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
                    {results.length > 0 ? (
                        <div className="flex flex-col gap-2">
                            {query.trim().length === 0 && (
                                <p className="px-2 text-xs leading-4 text-fg-secondary">Recent chats</p>
                            )}
                            <div className="flex flex-col">
                                {results.map((result) => (
                                    <div
                                        key={result.session_id}
                                        className="flex flex-col gap-0.5 p-2 rounded cursor-pointer hover:bg-hover transition-colors w-full"
                                        onClick={() => handleResultClick(result.session_id)}
                                    >
                                        <div className="text-sm leading-[18px] truncate w-full">
                                            <HighlightedText text={result.title} highlight={query} />
                                        </div>
                                        {result.matching_content && (
                                            <p className="text-xs leading-4 text-fg-muted break-words w-full line-clamp-2">
                                                {result.matching_content}
                                            </p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : (
                        query.trim().length > 0 && !isSearching && (
                            <p className="p-2 text-sm leading-[18px] text-fg-faint text-center">No results found</p>
                        )
                    )}

                    {query.trim().length === 0 && results.length === 0 && (
                        <p className="p-2 py-8 text-sm leading-[18px] text-fg-faint text-center">Start typing to search</p>
                    )}
                </div>
            </div>
        </div>
    );
}
