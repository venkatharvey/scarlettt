import { useState, useEffect, useRef } from 'react';
import { NO_AUTOCORRECT } from "../../../inputProps";
import { listen } from '@tauri-apps/api/event';
import { useOllama, canChat, hasTools, ModelSummary } from '../../../hooks/useOllama';
import ContextMeter from '../../../features/chat/components/ChatInput/ContextMeter';
import ChevronDown from "../../../svg/ChevronDown";
import KeyboardArrowDown from "../../../svg/KeyboardArrowDown";
import Newsstand from "../../../svg/Newsstand";

interface ModelSelectorProps {
    currentModel: string;
    onModelSelect: (model: string) => void;
    /** Opens the models library, where downloading and removing live. */
    onBrowseModels?: () => void;
    variant?: 'pill' | 'minimal';
    /** Set when this chat's recorded window exceeds what memory affords today. */
    contextAffordableNow?: number;
    /** Tokens this conversation occupied as of the last reply — see `ContextMeter`. */
    contextUsed?: number;
    /** The `num_ctx` this chat is sending. Absent means no meter. */
    contextLimit?: number;
}

/** Past this many models the list is worth filtering; below it, a field is noise. */
const SEARCH_THRESHOLD = 6;

export default function ModelSelector({ currentModel, onModelSelect, onBrowseModels, variant = 'pill', contextUsed, contextLimit, contextAffordableNow }: ModelSelectorProps) {
    const { listModels } = useOllama();

    const [isOpen, setIsOpen] = useState(false);
    // The minimal variant sits at the bottom of the window, where a downward
    // panel runs off-screen — so pick the side with more room and cap the
    // panel to it rather than assuming either direction.
    const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom');
    const [maxHeight, setMaxHeight] = useState<number>();
    // Same story horizontally: left-anchored, the 288px panel runs off the
    // right edge when the trigger sits near it.
    const [alignRight, setAlignRight] = useState(false);
    const [models, setModels] = useState<ModelSummary[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const dropdownRef = useRef<HTMLDivElement>(null);


    useEffect(() => {
        loadModels();

        const unlistenStatus = listen('ollama-status-update', (event) => {
            if (event.payload === 'Running') {
                loadModels();
            }
        });

        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            unlistenStatus.then(u => u());
        };
    }, []);

    const loadModels = async () => {
        try {
            setModels(await listModels());
        } catch (error) {
            console.error('Failed to load models:', error);
        }
    };

    const toggleDropdown = () => {
        if (isOpen) {
            setIsOpen(false);
            return;
        }
        // Re-read on open so models installed since mount show up.
        loadModels();
        setSearchQuery('');
        const rect = dropdownRef.current?.getBoundingClientRect();
        if (rect) {
            const GAP = 8;
            const MARGIN = 8;
            const PANEL_WIDTH = 288; // w-72
            const below = window.innerHeight - rect.bottom - GAP - MARGIN;
            const above = rect.top - GAP - MARGIN;
            const openUpward = above > below;
            setPlacement(openUpward ? 'top' : 'bottom');
            setMaxHeight(Math.max(200, openUpward ? above : below));
            setAlignRight(rect.left + PANEL_WIDTH > window.innerWidth - MARGIN);
        }
        setIsOpen(true);
    };

    // Chat models only. Embedding models (the one semantic search installs, above
    // all) can't hold a conversation, so a picker for choosing who to talk to has no
    // use for them — they're managed in Settings → Semantic search, and hidden from
    // the library, so the picker matches. This replaces the old show-but-disable row:
    // that existed so a model didn't seem to vanish, but the embedding model was never
    // user-chosen here in the first place, so there's nothing to reassure them about.
    const chatModels = models.filter(canChat);
    const showSearch = chatModels.length > SEARCH_THRESHOLD;
    const visibleModels = showSearch
        ? chatModels.filter(m => m.name.toLowerCase().includes(searchQuery.toLowerCase()))
        : chatModels;

    return (
        <div className="relative" ref={dropdownRef}>
            {variant === 'minimal' ? (
                <div
                    className="flex items-center gap-2 p-1 rounded cursor-pointer hover:bg-hover transition-colors"
                    onClick={toggleDropdown}
                >
                    <span className="text-xs leading-4 text-fg-secondary">
                        {currentModel || "Pick model"}
                    </span>
                    <KeyboardArrowDown size={16} color="rgb(var(--fg-secondary))" />
                </div>
            ) : (
                <div
                    className="flex items-center gap-2 px-4 py-2 bg-hover rounded-full cursor-pointer hover:bg-hover transition-colors"
                    onClick={toggleDropdown}
                >
                    <span className="text-sm font-medium text-fg">
                        {currentModel || "Select Model"}
                    </span>
                    <ChevronDown size={14} color="rgb(var(--fg-secondary))" />
                </div>
            )}

            {isOpen && (
                <div
                    className={`absolute w-72 bg-raised rounded-2xl shadow-lg border border-line p-2 z-[100] flex flex-col ${placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'} ${alignRight ? 'right-0' : 'left-0'}`}
                    style={{ maxHeight }}
                >
                    {/* Pinned above the list rather than under the row it
                        describes. Past `SEARCH_THRESHOLD` models the list
                        scrolls, so an in-line meter could sit out of view; a
                        search query that filters out the current model removed
                        it altogether. It also isn't really a property of a row
                        in a list of choices — it's the state of this
                        conversation, which is one thing, not one per model. */}
                    {contextLimit !== undefined && (
                        // Filled with the chat pane's own #f5f5f5 against the
                        // panel's #fafafa: enough to read as its own block that
                        // no divider is needed, without introducing a colour the
                        // app doesn't already use.
                        <div className="mb-2 px-3 py-2.5 rounded-lg bg-surface">
                            <p className="mb-1.5 text-xs leading-4 text-fg-muted">Context used</p>
                            <ContextMeter used={contextUsed} limit={contextLimit} affordableNow={contextAffordableNow} />
                        </div>
                    )}

                    {showSearch && (
                        <div className="pb-2">
                            <input
                                {...NO_AUTOCORRECT}
                                type="text"
                                className="w-full px-3 py-2 text-sm leading-[18px] text-fg bg-card rounded-lg border border-line focus:outline-none focus:border-fg-faint transition-colors placeholder-fg-muted"
                                placeholder="Search models"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                autoFocus
                            />
                        </div>
                    )}

                    {/* Installed models only — downloading and removing belong to the
                        library, where the memory and speed figures are shown. */}
                    <div className="overflow-y-auto flex-1 no-scrollbar" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
                        {visibleModels.length === 0 ? (
                            <p className="p-2 text-sm leading-[18px] text-fg-faint">
                                {models.length === 0
                                    ? "No models installed"
                                    : chatModels.length === 0
                                        ? "No chat models installed"
                                        : "No models match"}
                            </p>
                        ) : (
                            visibleModels.map((model) => (
                                <div
                                    key={model.name}
                                    className="flex items-center gap-2 p-2 rounded transition-colors cursor-pointer hover:bg-hover"
                                    onClick={() => {
                                        onModelSelect(model.name);
                                        setIsOpen(false);
                                    }}
                                >
                                    {/* Name and its capability chip travel together, 1rem
                                        apart, so the chip reads as belonging to the model
                                        rather than floating at the row's far edge. The
                                        chip is shown only when the model plainly declares
                                        the capability — see hasTools — and a tools model is
                                        still an ordinary chat model, so it never gates the
                                        row. `In use` stays at the right as a status. */}
                                    <div className="flex-1 min-w-0 flex items-center gap-4">
                                        <span className="min-w-0 text-sm leading-[18px] truncate text-fg">{model.name}</span>
                                        {hasTools(model) && (
                                            <span className="flex-shrink-0 px-1 py-0.5 rounded border border-line text-[10px] leading-none text-fg-muted">Tools</span>
                                        )}
                                    </div>
                                    {model.name === currentModel && (
                                        <span className="flex-shrink-0 text-xs leading-4 text-fg-muted">In use</span>
                                    )}
                                </div>
                            ))
                        )}
                    </div>

                    {onBrowseModels && (
                        <div className="pt-2 mt-1 border-t border-line">
                            <div
                                className="flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-hover transition-colors"
                                onClick={() => {
                                    onBrowseModels();
                                    setIsOpen(false);
                                }}
                            >
                                <span className="flex-shrink-0 flex items-center justify-center w-4 h-4">
                                    <Newsstand size={16} color="rgb(var(--fg-secondary))" />
                                </span>
                                <span className="text-sm leading-[18px] text-fg-secondary">Browse more models</span>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
