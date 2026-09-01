import { formatCount } from "../../../models/modelFacts";

/** Green below this, amber from here to `RED_FROM`, red above that. */
const AMBER_FROM = 0.6;
const RED_FROM = 0.9;

/**
 * Only the bar carries the colour. The percentage stays the same neutral grey as
 * the token count beside it — two differently-coloured numbers on one line read
 * as two separate readings, when they are the same fact stated twice.
 */
const FILL = {
    green: "bg-emerald-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
} as const;

/** Shares of the window that raise a notice, ascending. */
const NOTICE_LEVELS = [80, 90, 100] as const;
export type NoticeLevel = (typeof NOTICE_LEVELS)[number];

/**
 * Tokens used, to two decimals of a k.
 *
 * `formatCount` rounds to whole k, which is right for a window size that never
 * moves but wrong for a running total: at 3,900 of 4,096 it rendered "4k / 4k",
 * a full-looking readout at 95%. Same ÷1024 as everywhere else — the values are
 * powers of two, and ÷1000 disagrees with every model spec sheet.
 */
function formatUsed(n: number): string {
    if (n < 1024) return String(n);
    return `${(n / 1024).toFixed(2)}k`;
}

interface ContextMeterProps {
    /**
     * Tokens the conversation occupied as of the last reply, or 0 before one has
     * landed — an empty chat has genuinely used nothing, so the bar starts at
     * zero rather than being absent and shifting the composer when it appears.
     *
     * Measured rather than estimated: Ollama reports `prompt_eval_count` for the
     * whole prompt it evaluated, not just the newly-seen tail — verified against
     * a two-turn exchange where turn 1 reported 41 and turn 2 reported 85, the
     * running total rather than the 20-odd tokens that were actually new.
     */
    used?: number;
    /** The `num_ctx` this chat is really sending. */
    limit: number;
    /**
     * Set when `limit` is this chat's *recorded* window and the machine would only
     * grant a smaller one today, because free memory has fallen since the
     * conversation started. The window is still honoured — silently shrinking it
     * would make the turns above mean something different from the turns below —
     * so the trade is stated in the tooltip instead.
     */
    affordableNow?: number;
}

/**
 * How full the current conversation's context window is.
 *
 * Absent before the first reply rather than showing zero: the count comes from
 * the last response, so until one lands there is nothing measured to show, and
 * Ollama exposes no tokenizer to count what is currently typed. A character
 * estimate would be the one guessed figure on a screen whose numbers are
 * otherwise all measured.
 */
export default function ContextMeter({ used = 0, limit, affordableNow }: ContextMeterProps) {
    if (!limit) return null;

    const share = used / limit;
    const percent = share * 100;
    const fill = FILL[share >= RED_FROM ? "red" : share >= AMBER_FROM ? "amber" : "green"];

    // Rounding hides the difference between "empty" and "barely started", which
    // is most of a long window's life — say `<1%` rather than a flat 0%.
    const label = percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;

    return (
        <div
            className="flex flex-col gap-1"
            title={
                `${used.toLocaleString()} of ${limit.toLocaleString()} tokens used, as of the last reply.` +
                (affordableNow !== undefined
                    ? ` This chat was started at ${formatCount(limit)}, which is more than the ${formatCount(affordableNow)} free memory would allow right now — it is kept so the conversation stays consistent, at the cost of a slower load.`
                    : "")
            }
        >
            {/* Ollama drops the oldest messages rather than overflowing, so the
                fill pins at full instead of running past it — but the figures
                below stay truthful, which is how lowering the context setting on
                an existing chat can legitimately read past 100%. */}
            <div className="h-1 w-full rounded-full bg-hover overflow-hidden">
                <div
                    className={`h-full rounded-full transition-all ${fill}`}
                    style={{ width: `${Math.min(percent, 100)}%` }}
                />
            </div>
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs leading-4 text-fg-muted tabular-nums">
                    {formatUsed(used)} / {formatCount(limit)}
                </span>
                <span className="text-xs leading-4 text-fg-muted tabular-nums">{label}</span>
            </div>
        </div>
    );
}

/**
 * The highest notice threshold this conversation has reached, or null below the
 * first one.
 *
 * Levels rather than a single "full" flag so acknowledging the early warning
 * doesn't silence the later ones — 80% is a heads-up, 100% is a different event
 * with actual consequences, and dismissing the first shouldn't hide the last.
 */
export function contextNoticeLevel(used?: number, limit?: number): NoticeLevel | null {
    if (!used || !limit) return null;
    const percent = (used / limit) * 100;
    let reached: NoticeLevel | null = null;
    for (const level of NOTICE_LEVELS) if (percent >= level) reached = level;
    return reached;
}
