import AttachFile from "../../../../svg/AttachFile";
import AddThin from "../../../../svg/AddThin";
import ArrowUpward from "../../../../svg/ArrowUpward";
import SendMessage from "../../../../svg/SendMessage";
import Stop from "../../../../svg/Stop";
import ModelSelector from "../../../../components/layout/Header/ModelSelector";
import { NoticeLevel } from "./ContextMeter";
import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

interface AttachedFile {
    name: string;
    path: string;
    content: string;
}

/**
 * The one list the `+` picker's dialog filter and the drag-and-drop filter both
 * read from, so the two ways of attaching accept exactly the same files. These are
 * text formats: attachments are inlined into the prompt as `<file>` blocks, so a
 * binary would arrive as garbage. Dropped files outside this set are ignored.
 */
const ALLOWED_EXTENSIONS = ['txt', 'md', 'py', 'js', 'ts', 'tsx', 'cpp', 'rs', 'json', 'csv'];

interface ChatInputProps {
    onSendMessage: (message: string) => void;
    disabled?: boolean;
    /**
     * Ends the reply that's generating. Present only while one is — the button
     * takes the send arrow's place rather than sitting beside it, because at that
     * moment stopping is the only thing that control can usefully do.
     */
    onStop?: () => void;
    variant?: 'default' | 'hero';
    model?: string;
    onModelSelect?: (model: string) => void;
    onBrowseModels?: () => void;
    placeholder?: string;
    /** Tokens this conversation occupied as of the last reply — see `ContextMeter`. */
    contextUsed?: number;
    /** The `num_ctx` this chat is sending. */
    contextLimit?: number;
    /** Set when this chat's recorded window exceeds what memory affords today. */
    contextAffordableNow?: number;
    /** Threshold reached and not yet acknowledged for this chat, if any. */
    contextNotice?: NoticeLevel;
    onAcknowledgeContext?: () => void;
}

/**
 * One line each, so the notice never grows the composer by a second row. The
 * first two warn while there's still room to act; the last reports something
 * that has already started happening.
 */
const NOTICE_COPY: Record<NoticeLevel, string> = {
    80: "Context window 80% full.",
    90: "Context window 90% full — oldest messages drop out shortly.",
    100: "Context window full — oldest messages are now being dropped.",
};

function ChatInput({ onSendMessage, onStop, disabled = false, variant = 'default', model, onModelSelect, onBrowseModels, placeholder, contextUsed, contextLimit, contextAffordableNow, contextNotice, onAcknowledgeContext }: ChatInputProps) {
    const [message, setMessage] = useState("");
    const [attachments, setAttachments] = useState<AttachedFile[]>([]);
    const [isParsing, setIsParsing] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    // The composer card — the "chat field" a drop has to land inside to attach.
    const cardRef = useRef<HTMLDivElement>(null);

    /**
     * The shared read-and-attach path. Both the `+` picker and a file drop end up
     * here with a list of absolute paths, so the two behave identically: filter to
     * the text formats we can inline, read each off disk, and stack the ones that
     * aren't already attached. Reading by path is why drop uses Tauri's own
     * drag-drop event (which carries paths) rather than HTML5 DnD (which, with
     * Tauri intercepting OS drops, wouldn't).
     */
    const addFilesByPath = async (paths: string[]) => {
        const accepted = paths.filter(p => {
            const ext = p.split('.').pop()?.toLowerCase();
            return ext ? ALLOWED_EXTENSIONS.includes(ext) : false;
        });
        if (accepted.length === 0) return;

        setIsParsing(true);
        try {
            const read: AttachedFile[] = [];
            for (const path of accepted) {
                try {
                    const name = path.split(/[/\\]/).pop() || 'unknown';
                    const content = await invoke<string>('read_attachment_file', { path });
                    read.push({ name, path, content });
                } catch (err) {
                    // A single unreadable file (a folder dropped in, a permission
                    // error) must not sink the rest of the batch.
                    console.error('Error reading file:', path, err);
                }
            }
            if (read.length > 0) {
                setAttachments(prev => {
                    const existing = new Set(prev.map(a => a.path));
                    const fresh = read.filter(a => !existing.has(a.path));
                    return fresh.length > 0 ? [...prev, ...fresh] : prev;
                });
            }
        } finally {
            setIsParsing(false);
        }
    };

    const handleFileSelect = async () => {
        try {
            const selected = await open({
                multiple: true,
                filters: [{ name: 'Text Files', extensions: ALLOWED_EXTENSIONS }]
            });

            if (selected) {
                const filePaths = Array.isArray(selected) ? selected : [selected];
                await addFilesByPath(filePaths);
            }
        } catch (error) {
            console.error('Error selecting file:', error);
        }
    };

    const removeAttachment = (index: number) => {
        setAttachments(prev => prev.filter((_, i) => i !== index));
    };

    // A drop is only "in the chat field" when it lands over the composer card.
    // Tauri reports the drop in physical pixels from the window's top-left, and
    // getBoundingClientRect is CSS pixels from the same origin, so scale by DPR.
    const isPositionOverCard = (pos: { x: number; y: number }) => {
        const el = cardRef.current;
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        return pos.x >= r.left * dpr && pos.x <= r.right * dpr &&
               pos.y >= r.top * dpr && pos.y <= r.bottom * dpr;
    };

    // Refs so the single, long-lived drag-drop listener always calls the current
    // closures — re-registering the OS listener on every render would drop events
    // mid-drag and churn the subscription.
    const isOverCardRef = useRef(isPositionOverCard);
    isOverCardRef.current = isPositionOverCard;
    const addFilesRef = useRef(addFilesByPath);
    addFilesRef.current = addFilesByPath;

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let cancelled = false;
        (async () => {
            try {
                const un = await getCurrentWebview().onDragDropEvent((event) => {
                    const p = event.payload;
                    if (p.type === 'enter' || p.type === 'over') {
                        setIsDragOver(isOverCardRef.current(p.position));
                    } else if (p.type === 'drop') {
                        const over = isOverCardRef.current(p.position);
                        setIsDragOver(false);
                        if (over) addFilesRef.current(p.paths);
                    } else {
                        // 'leave' — drag left the window or was cancelled.
                        setIsDragOver(false);
                    }
                });
                // Unmounted before the async registration resolved: tear straight down.
                if (cancelled) un(); else unlisten = un;
            } catch {
                // No Tauri webview (browser preview) — OS file drops don't exist
                // there, so there's nothing to wire up.
            }
        })();
        return () => { cancelled = true; unlisten?.(); };
    }, []);

    const handleSend = () => {
        if ((message.trim() || attachments.length > 0) && !disabled && !isParsing) {
            let finalPrompt = "";

            if (attachments.length > 0) {
                finalPrompt += "[Context from attached files]\n";
                attachments.forEach(file => {
                    finalPrompt += `<file name="${file.name}">\n${file.content}\n</file>\n\n`;
                });
                finalPrompt += "[User Message]\n";
            }

            finalPrompt += message.trim();

            onSendMessage(finalPrompt);
            setMessage("");
            setAttachments([]);
            if (textareaRef.current) {
                textareaRef.current.style.height = "auto";
            }
        }
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleInput = () => {
        const textarea = textareaRef.current;
        if (textarea) {
            textarea.style.height = "auto";
            textarea.style.height = textarea.scrollHeight + "px";
        }
    };

    const isHero = variant === 'hero';
    const canSend = !disabled && !isParsing && (message.trim() || attachments.length > 0);

    return (
        <div className="flex flex-col gap-2 w-full">
            {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 px-1">
                    {attachments.map((file, index) => (
                        <div key={index} className="flex items-center gap-2 bg-hover px-3 py-1.5 rounded-lg text-sm group">
                            <span className="max-w-[150px] truncate font-medium text-fg-secondary">{file.name}</span>
                            <button
                                onClick={() => removeAttachment(index)}
                                className="text-fg-faint hover:text-bad-fg transition-colors"
                                title="Remove file"
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                </div>
            )}
            {/* 0.25rem between the notice and the composer — close enough to read
                as attached to the field it's warning about. */}
            <div className="flex flex-col gap-1">
            {/* The moments that deserve words rather than a bar: past the window
                Ollama silently drops the oldest turns, so a chat starts forgetting
                its own beginning with nothing on screen to say so. Raised again on
                every further turn until acknowledged — a warning about losing
                information shouldn't be dismissible by simply being ignored. */}
            {contextNotice && (
                <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-inverse shadow-sm">
                    {/* `truncate` guarantees the single line survives a narrow
                        window; the title carries the full text if it ever does. */}
                    <p className="flex-1 min-w-0 truncate text-xs leading-4 text-inverse-fg" title={NOTICE_COPY[contextNotice]}>
                        {NOTICE_COPY[contextNotice]}
                    </p>
                    <button
                        className="flex-shrink-0 px-2 py-0.5 rounded-md text-xs leading-4 text-fg bg-raised hover:bg-card transition-colors"
                        onClick={onAcknowledgeContext}
                    >
                        Got it
                    </button>
                </div>
            )}
            <div
                ref={cardRef}
                className={`relative flex flex-col w-full transition-all ${isHero ? "bg-raised p-4 rounded-2xl gap-8" : "bg-hover p-3 rounded-xl gap-6 border border-transparent focus-within:border-line-strong shadow-sm"} ${isDragOver ? "ring-2 ring-fg/70" : ""}`}
            >
                {/* Shown only while files hover over the field — the same attach the
                    `+` performs, made discoverable for a drop. `pointer-events-none`
                    so it never blocks the controls beneath it. */}
                {isDragOver && (
                    <div className={`absolute inset-0 z-10 flex items-center justify-center gap-2 pointer-events-none ${isHero ? "rounded-2xl bg-raised/95" : "rounded-xl bg-hover/95"}`}>
                        <AttachFile size={18} color="rgb(var(--fg))" />
                        <span className="text-sm font-medium text-fg">Drop files to attach</span>
                    </div>
                )}
                <textarea
                    ref={textareaRef}
                    placeholder={isParsing ? "Reading files..." : (placeholder ?? (isHero ? "How can i help you today?" : "Ask anything . . ."))}
                    className={`hero-input focus:outline-none focus:ring-0 w-full break-words resize-none overflow-y-auto max-h-40 disabled:opacity-50 ${isHero ? "bg-raised p-0 text-sm font-normal leading-[18px] text-fg" : "bg-hover p-2 text-lg"}`}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onInput={handleInput}
                    onKeyDown={handleKeyDown}
                    disabled={disabled || isParsing}
                    /* A prompt is not prose. macOS defaults rewrite what you type —
                       capitalising the start of every line, "correcting" identifiers
                       and flag names, and offering completions over the composer —
                       which is wrong for text that's often code, paths or model
                       names. Misspellings are still underlined; nothing is changed
                       for you. Note the OS-level substitutions in System Settings
                       (smart quotes, text replacements) sit above the web layer and
                       aren't ours to switch off. */
                    autoCorrect="off"
                    autoCapitalize="off"
                    autoComplete="off"
                    spellCheck
                    data-gramm="false"
                />
                <div className={`flex items-center ${isHero ? "justify-between" : "gap-6"}`}>
                    {isHero ? (
                        <div
                            className={`flex items-center justify-center p-1 rounded cursor-pointer hover:bg-hover transition-colors ${isParsing ? 'opacity-50 cursor-not-allowed' : ''}`}
                            onClick={!isParsing ? handleFileSelect : undefined}
                        >
                            <AddThin size={16} color="rgb(var(--fg))" />
                        </div>
                    ) : (
                        <div
                            className={`flex items-center gap-2 bg-card p-1.5 rounded-3xl cursor-pointer hover:bg-hover transition-colors shadow-sm ${isParsing ? 'opacity-50 cursor-not-allowed' : ''}`}
                            onClick={!isParsing ? handleFileSelect : undefined}
                        >
                            <AttachFile size={20} color="rgb(var(--fg))"/>
                        </div>
                    )}

                    {isParsing && (
                        <div className="text-xs text-fg-muted animate-pulse font-medium">
                            Parsing files...
                        </div>
                    )}

                    {isHero ? (
                        <div className="flex items-center gap-4">
                            {onModelSelect && (
                                <ModelSelector
                                    currentModel={model || ""}
                                    onModelSelect={onModelSelect}
                                    onBrowseModels={onBrowseModels}
                                    variant="minimal"
                                    contextUsed={contextUsed}
                                    contextLimit={contextLimit}
                                    contextAffordableNow={contextAffordableNow}
                                />
                            )}
                            {onStop ? (
                                <div
                                    className="flex items-center justify-center p-1 rounded bg-inverse cursor-pointer transition-all hover:scale-105 active:scale-95"
                                    onClick={onStop}
                                    title="Stop generating"
                                >
                                    <Stop size={16} color="rgb(var(--inverse-fg))" />
                                </div>
                            ) : (
                                <div
                                    className={`flex items-center justify-center p-1 rounded transition-all ${canSend ? 'bg-inverse cursor-pointer hover:scale-105 active:scale-95' : 'bg-hover opacity-50 cursor-not-allowed'}`}
                                    onClick={handleSend}
                                >
                                    <ArrowUpward size={16} color={canSend ? "rgb(var(--inverse-fg))" : "rgb(var(--fg))"} />
                                </div>
                            )}
                        </div>
                    ) : (
                        <div
                            className={`flex items-center gap-2 ml-auto bg-inverse p-1 rounded-3xl transition-all ${onStop || canSend ? 'cursor-pointer hover:scale-105 active:scale-95' : 'opacity-50 cursor-not-allowed'}`}
                            onClick={onStop ?? handleSend}
                            title={onStop ? "Stop generating" : undefined}
                        >
                            {onStop ? <Stop size={20} color="rgb(var(--inverse-fg))" /> : <SendMessage size={20} color="rgb(var(--inverse-fg))"/>}
                        </div>
                    )}
                </div>
            </div>
            </div>
        </div>
    );
}

export default ChatInput;
