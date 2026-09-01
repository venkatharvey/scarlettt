import { useEffect, useState } from "react";

interface GenerationStatusProps {
    /** `Date.now()` at the moment the request went out. */
    startedAt: number;
    /** Tokens streamed back so far. */
    tokenCount: number;
}

function formatElapsed(seconds: number): string {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/**
 * The live counterpart to the timer tooltip on a finished message: what this
 * response is costing while it's still being written.
 *
 * Owns its own tick rather than accepting an elapsed value as a prop. Driving it
 * from ChatPage would re-render the whole message list four times a second — and
 * that list contains every markdown block in the conversation.
 */
export default function GenerationStatus({ startedAt, tokenCount }: GenerationStatusProps) {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 250);
        return () => window.clearInterval(timer);
    }, []);

    const seconds = Math.max(0, (now - startedAt) / 1000);
    // Rate is nonsense before a second has passed — too few samples, and it reads
    // as either 0 or an absurd spike on the first token.
    const rate = seconds >= 1 && tokenCount > 0 ? tokenCount / seconds : undefined;

    const parts = [
        formatElapsed(seconds),
        tokenCount > 0 ? `${tokenCount} token${tokenCount === 1 ? "" : "s"}` : null,
        rate !== undefined ? `${rate.toFixed(1)} tok/s` : null,
    ].filter(Boolean) as string[];


    return (
        // tabular-nums keeps the digits from reflowing the row as they tick.
        <span className="flex items-center gap-1.5 text-xs leading-4 text-fg-muted tabular-nums">
            <span className="flex items-center gap-1.5">
                {parts.map((part, i) => (
                    <span key={part} className="flex items-center gap-1.5">
                        {i > 0 && <span className="text-fg-faint">·</span>}
                        {part}
                    </span>
                ))}
            </span>
        </span>
    );
}
