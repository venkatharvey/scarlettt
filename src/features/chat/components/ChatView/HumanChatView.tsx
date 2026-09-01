import { memo } from "react";
import { NO_REWRITE } from "../../../../inputProps";
import { useState, useEffect } from "react";
import EditGlyph from "../../../../svg/chat/EditGlyph";
import ContentCopyGlyph from "../../../../svg/chat/ContentCopyGlyph";
import { useCopied, CopiedBubble } from "./useCopied";
import DeleteGlyph from "../../../../svg/chat/DeleteGlyph";
import FileIcon from "../../../../svg/AttachFile";
import { formatRelativeTime } from "../../relativeTime";

interface HumanChatViewProps {
    message: string;
    timestamp?: string;
    onEdit?: (timestamp: string, newContent: string) => void;
    onDelete?: (timestamp: string) => void;
}

// Relative "time ago": "just now", "5 minutes ago", "1 hour ago", "12 days ago",
// "48 weeks ago", "5 years ago".
interface ParsedMessage {
    attachments: string[];
    userContent: string;
    isFormatted: boolean;
    rawFileBlocks: string[];
}

/** Memoised for the same reason as `AIChatView` — see the note there. */
function HumanChatView({ message: initialMessage, timestamp, onEdit, onDelete }: HumanChatViewProps) {
    const [isEditing, setIsEditing] = useState(false);
    const { copied, copy } = useCopied();

    const parseMessage = (msg: string): ParsedMessage => {
        const fileRegex = /<file name="([^"]+)">([\s\S]*?)<\/file>/g;
        const attachments: string[] = [];
        const rawFileBlocks: string[] = [];
        let match;

        while ((match = fileRegex.exec(msg)) !== null) {
            attachments.push(match[1]);
            rawFileBlocks.push(match[0]);
        }

        const userMessageMarker = "[User Message]\n";
        const markerIndex = msg.indexOf(userMessageMarker);

        if (markerIndex !== -1) {
            const userContent = msg.substring(markerIndex + userMessageMarker.length).trim();
            return { attachments, userContent, isFormatted: true, rawFileBlocks };
        }

        return { attachments: [], userContent: msg, isFormatted: false, rawFileBlocks: [] };
    };

    const parsed = parseMessage(initialMessage);
    const [editValue, setEditValue] = useState(parsed.userContent);

    useEffect(() => {
        const newParsed = parseMessage(initialMessage);
        setEditValue(newParsed.userContent);
    }, [initialMessage]);

    const handleSave = () => {
        if (editValue.trim() && onEdit && timestamp) {
            let fullMessage = "";
            if (parsed.isFormatted) {
                fullMessage += "[Context from attached files]\n";
                parsed.rawFileBlocks.forEach(block => {
                    fullMessage += block + "\n\n";
                });
                fullMessage += "[User Message]\n";
            }
            fullMessage += editValue.trim();

            onEdit(timestamp, fullMessage);
            setIsEditing(false);
        }
    };

    const handleCancel = () => {
        setEditValue(parsed.userContent);
        setIsEditing(false);
    };

    const handleCopy = () => {
        copy(parsed.userContent);
    };

    // gap-1 (0.25rem) separates the bubble from the action row below it, which
    // sat flush against it before.
    return (
        <div className="flex flex-col items-end w-full group gap-1">
            {/* Message bubble — Neutral/200 (#E5E5E5), 8px radius, 12/8 padding */}
            <div className={`flex flex-col items-start overflow-hidden rounded-lg bg-line p-3 max-w-[85%] ${isEditing ? "min-w-[320px]" : ""}`}>
                {parsed.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                        {parsed.attachments.map((name, i) => (
                            <div key={i} className="flex items-center gap-1.5 bg-card/60 px-2.5 py-1 rounded-lg text-xs font-medium text-fg-secondary">
                                <FileIcon size={12} color="rgb(var(--fg-secondary))" />
                                <span className="max-w-[120px] truncate">{name}</span>
                            </div>
                        ))}
                    </div>
                )}
                {isEditing ? (
                    <div className="flex flex-col gap-6 w-full">
                        <textarea
                            {...NO_REWRITE}
                            className="w-full bg-transparent text-sm leading-[18px] outline-none resize-none overflow-hidden text-fg"
                            value={editValue}
                            onChange={(e) => {
                                setEditValue(e.target.value);
                                e.target.style.height = "auto";
                                e.target.style.height = e.target.scrollHeight + "px";
                            }}
                            autoFocus
                            rows={1}
                            onFocus={(e) => {
                                const length = e.target.value.length;
                                e.target.setSelectionRange(length, length);
                                e.target.style.height = "auto";
                                e.target.style.height = e.target.scrollHeight + "px";
                            }}
                        />
                        <div className="flex justify-end gap-1">
                            <button
                                onClick={handleCancel}
                                className="px-3 py-1 text-xs leading-[14px] font-medium text-fg-secondary hover:text-fg transition-colors rounded"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                className="px-3 py-1 text-xs leading-[14px] font-medium bg-inverse text-inverse-fg rounded hover:bg-inverse transition-colors"
                            >
                                Send
                            </button>
                        </div>
                    </div>
                ) : (
                    <p className="text-sm leading-[18px] break-words whitespace-pre-wrap text-fg">{parsed.userContent}</p>
                )}
            </div>

            {!isEditing && (
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="flex items-center gap-1">
                        <button onClick={() => setIsEditing(true)} className="flex items-center justify-center w-6 h-6 rounded hover:bg-hover/70 transition-colors" title="Edit">
                            <EditGlyph size={14} color="rgb(var(--fg))" />
                        </button>
                        <button
                            onClick={handleCopy}
                            className="relative flex items-center justify-center w-6 h-6 rounded hover:bg-hover/70 transition-colors"
                            title={copied ? "Copied" : "Copy"}
                        >
                            <ContentCopyGlyph size={14} color="rgb(var(--fg))" />
                            <CopiedBubble show={copied} />
                        </button>
                        {onDelete && timestamp && (
                            <button onClick={() => onDelete(timestamp)} className="flex items-center justify-center w-6 h-6 rounded hover:bg-hover/70 transition-colors" title="Delete">
                                <DeleteGlyph size={14} color="rgb(var(--fg))" />
                            </button>
                        )}
                    </div>
                    {timestamp && (
                        <span className="text-xs leading-4 text-fg-faint whitespace-nowrap">{formatRelativeTime(timestamp)}</span>
                    )}
                </div>
            )}
        </div>
    );
}

export default memo(HumanChatView);
