import { memo, useState } from "react";
import ToolGlyph from "../../../../svg/chat/ToolGlyph";

export type ToolDecision = "allow-once" | "allow-session" | "deny";

/**
 * The shape a card needs, satisfied by both a live `StreamToolCall` (status set)
 * and a persisted `ToolInteraction` (no status — it already ran, so it reads as
 * `done`). Keeping `status` optional is what lets ChatPage pass either array
 * straight through without a per-render mapping that would break `AIChatView`'s memo.
 */
export interface DisplayToolCall {
    callId: string;
    /** Namespaced name the model called (`serverid__tool`) — the fallback label. */
    tool: string;
    /** The server-local tool name and the server id, for a friendlier header. */
    toolName: string;
    server: string;
    arguments: unknown;
    status?: "awaiting-approval" | "running" | "done";
    result?: string;
    isError?: boolean;
    /** allow-once | allow-session | auto | deny | offline. */
    decision?: string;
}

export interface ToolCallCardProps extends Omit<DisplayToolCall, "callId"> {
    /** Present only for a live call still awaiting the user. */
    onApprove?: (decision: ToolDecision) => void;
}

/** Compact, readable rendering of the arguments — pretty JSON, never truncated to
 *  a lie; the box scrolls instead. */
function formatArgs(args: unknown): string {
    if (args == null) return "";
    try {
        const json = JSON.stringify(args, null, 2);
        // An empty object is not worth a block.
        return json === "{}" ? "" : json;
    } catch {
        return String(args);
    }
}

function StatusPill({ status, isError, decision }: Pick<ToolCallCardProps, "status" | "isError" | "decision">) {
    let label: string;
    let cls: string;
    if (status === "awaiting-approval") {
        label = "Needs approval";
        cls = "bg-warn-bg text-warn-fg border-warn-line";
    } else if (status === "running") {
        label = "Running…";
        cls = "bg-info-bg text-info-fg border-info-line";
    } else if (decision === "deny") {
        label = "Declined";
        cls = "bg-hover text-fg-muted border-line";
    } else if (isError) {
        label = "Error";
        cls = "bg-bad-bg text-bad-fg border-bad-line";
    } else {
        label = "Done";
        cls = "bg-good-bg text-good-fg border-good-line";
    }
    return <span className={`px-2 py-0.5 rounded-full border text-xs leading-4 ${cls}`}>{label}</span>;
}

function ToolCallCard({ tool, toolName, server, arguments: args, status: rawStatus, result, isError, decision, onApprove }: ToolCallCardProps) {
    // The result can be long; keep it collapsed past a few lines.
    const [expanded, setExpanded] = useState(false);
    const argText = formatArgs(args);
    const label = toolName || tool;
    // A persisted interaction carries no status — it already ran, so it is `done`.
    const status = rawStatus ?? "done";

    const resultLong = (result?.split("\n").length ?? 0) > 6 || (result?.length ?? 0) > 400;

    return (
        <div className="rounded-lg border border-line bg-card overflow-hidden">
            {/* Header — what tool, on what server, and where it stands. */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
                <ToolGlyph size={14} color="rgb(var(--fg-secondary))" />
                <span className="text-sm text-fg font-medium truncate">{label}</span>
                {server && <span className="text-xs text-fg-faint truncate">{server}</span>}
                <span className="ml-auto flex-shrink-0">
                    <StatusPill status={status} isError={isError} decision={decision} />
                </span>
            </div>

            {/* Arguments — the actual call, so approval is of the real thing. */}
            {argText && (
                <pre className="px-3 py-2 text-xs leading-5 font-mono text-fg-secondary bg-raised overflow-x-auto whitespace-pre max-h-40 overflow-y-auto m-0">
                    {argText}
                </pre>
            )}

            {/* Approval — only while the loop is actually waiting on the user. */}
            {status === "awaiting-approval" && onApprove && (
                <div className="flex flex-col gap-2 px-3 py-2 border-t border-line">
                    <p className="text-xs leading-4 text-fg-muted">
                        Run <span className="text-fg">{label}</span> with these arguments?
                    </p>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => onApprove("allow-once")}
                            className="px-2.5 py-1 rounded-md bg-inverse text-inverse-fg text-xs leading-4 hover:bg-inverse-hover transition-colors"
                        >
                            Allow once
                        </button>
                        <button
                            onClick={() => onApprove("allow-session")}
                            className="px-2.5 py-1 rounded-md border border-line-strong text-fg text-xs leading-4 hover:bg-hover transition-colors"
                        >
                            Allow for session
                        </button>
                        <button
                            onClick={() => onApprove("deny")}
                            className="px-2.5 py-1 rounded-md border border-line-strong text-fg-muted text-xs leading-4 hover:bg-hover transition-colors"
                        >
                            Deny
                        </button>
                    </div>
                </div>
            )}

            {/* Result — once it has run (or was declined). */}
            {status === "done" && result != null && result !== "" && (
                <div className="border-t border-line">
                    <pre
                        className={`px-3 py-2 text-xs leading-5 font-mono overflow-x-auto whitespace-pre-wrap break-words m-0 ${
                            isError ? "text-bad-fg bg-bad-bg" : "text-fg-secondary"
                        } ${resultLong && !expanded ? "max-h-24 overflow-y-hidden" : "max-h-72 overflow-y-auto"}`}
                    >
                        {result}
                    </pre>
                    {resultLong && (
                        <button
                            onClick={() => setExpanded(e => !e)}
                            className="px-3 py-1.5 text-xs leading-4 text-fg-muted hover:text-fg transition-colors"
                        >
                            {expanded ? "Show less" : "Show more"}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

export default memo(ToolCallCard);
