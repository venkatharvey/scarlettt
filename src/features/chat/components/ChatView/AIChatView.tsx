import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import Copy from "../../../../svg/Copy";
import TimerGlyph from "../../../../svg/chat/TimerGlyph";
import ReplayGlyph from "../../../../svg/chat/ReplayGlyph";
import ContentCopyGlyph from "../../../../svg/chat/ContentCopyGlyph";
import { useCopied, CopiedBubble } from "./useCopied";
import ArrowSplitGlyph from "../../../../svg/chat/ArrowSplitGlyph";
import { MessageStats } from "../../../../hooks/useChatStorage";
import { formatRelativeTime } from "../../relativeTime";
import { splitThinking } from "../../thinking";
import ToolCallCard, { DisplayToolCall, ToolDecision } from "./ToolCallCard";
import "highlight.js/styles/github-dark.css";

interface AIChatViewProps {
    message: string;
    isStreaming?: boolean;
    timestamp?: string;
    stats?: MessageStats;
    onRegenerate?: (timestamp: string) => void;
    /** Forks the conversation, keeping this reply and everything before it. */
    onBranch?: (timestamp: string) => void;
    /**
     * Tool calls made during this turn, rendered as cards above the answer. Pass
     * the array by stable reference (the persisted or the store array) — never a
     * freshly-mapped one, or this component's memo is defeated on every token.
     */
    toolCalls?: DisplayToolCall[];
    /** Only for the in-flight reply: approve a call still awaiting the user. */
    onApprove?: (callId: string, decision: ToolDecision) => void;
}

// Matches the sidebar collapse toggle: 24px hit box, same hover wash. No
// disabled: variant — the timer is display-only but still hovers.
/**
 * The code block's own copy button. Its label carries the confirmation instead of
 * a bubble — the button already has text, and swapping it reads more clearly than
 * floating a second word above a header that is only two lines tall.
 */
function CodeCopyButton({ code }: { code: string }) {
    const { copied, copy } = useCopied();
    return (
        <button
            onClick={() => copy(code)}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-white transition-colors"
        >
            <Copy size={14} color="currentColor" />
            <span className="text-xs">{copied ? "Copied" : "Copy"}</span>
        </button>
    );
}

const ACTION_BUTTON_CLASS =
    "flex items-center justify-center w-6 h-6 rounded hover:bg-hover/70 transition-colors";

function formatDuration(ms: number) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Generation stats for the timer icon. Ollama only reports these on the final
 * chunk, so anything streamed before the feature existed has none.
 */
function statsSummary(stats?: MessageStats): string | null {
    if (!stats) return null;
    const { duration_ms, prompt_tokens, eval_tokens } = stats;
    const parts: string[] = [];

    if (duration_ms != null) parts.push(formatDuration(duration_ms));
    if (eval_tokens != null) parts.push(`${eval_tokens} tokens`);
    if (duration_ms != null && eval_tokens != null && duration_ms > 0) {
        parts.push(`${(eval_tokens / (duration_ms / 1000)).toFixed(1)} tok/s`);
    }
    if (prompt_tokens != null) parts.push(`${prompt_tokens} prompt`);
    if (!parts.length) return null;

    return parts.join(" · ");
}

/**
 * Memoised, and the callbacks it receives are identity-stable, because this is
 * the hot path.
 *
 * ChatPage re-renders on every streamed token — it has to, the reply lives in a
 * store it subscribes to. Without this, every *finished* message in the
 * conversation re-parsed its markdown and re-ran syntax highlighting on each
 * token too. Measured on a 24-message conversation with code blocks: one ~29-token
 * reply produced 4,188ms of main-thread blocking across 8 long tasks, the worst a
 * single 680ms freeze — which is what a stuttering spinner and a laggy window
 * actually are.
 */
function AIChatView({ message: initialMessage, isStreaming = false, timestamp, stats, onRegenerate, onBranch, toolCalls, onApprove }: AIChatViewProps) {
    /**
     * Reasoning is not displayed. `splitThinking` is still used to *drop* it: a
     * model that inlines its own `<think>` tags would otherwise render them as
     * literal text in the answer.
     */
    const { answer } = splitThinking(initialMessage);
    const isComplete = !isStreaming;
    const { copied, copy } = useCopied();
    const summary = statsSummary(stats);


    const handleCopy = () => {
        copy(answer || initialMessage);
    };

    const markdownComponents = {
        pre({ children }: any) {
            return <>{children}</>;
        },
        code({ inline, className, children, ...props }: any) {
            const extractText = (child: any): string => {
                if (typeof child === "string") return child;
                if (Array.isArray(child)) return child.map(extractText).join("");
                if (child?.props?.children) return extractText(child.props.children);
                return "";
            };
            const codeString = extractText(children);
            const match = /language-(\w+)/.exec(className || "");
            const isMultiLine = codeString.includes("\n");
            const isBlock = !inline && (match || isMultiLine);

            return isBlock ? (
                <div className="relative group my-4 rounded-lg overflow-hidden border border-zinc-700">
                    <div className="flex items-center justify-between px-4 py-2 bg-zinc-800 border-b border-zinc-700">
                        <span className="text-xs text-zinc-400 font-mono">{match ? match[1] : "text"}</span>
                        <CodeCopyButton code={codeString} />
                    </div>
                    {/*
                        Padding lives on the <code>, not here. highlight.js's own
                        stylesheet sets `pre code.hljs { padding: 1em }`, so a `p-4`
                        on the <pre> as well gave every highlighted block 32px of
                        inset instead of 16.
                        The inset below covers both cases at one value. It is
                        `!p-4` rather than `p-4` because hljs's `pre code.hljs`
                        out-specifies a plain utility class, which left highlighted
                        blocks on its `1em` — and `1em` against `text-sm` is 14px,
                        so highlighted and unhighlighted blocks disagreed by 2px.
                        Overriding a vendor stylesheet is what the important flag is
                        for; a block with no recognised language never gets `.hljs`
                        at all and needs the same class anyway, or it would sit
                        flush against the border.
                    */}
                    <pre className="bg-zinc-900 text-zinc-100 overflow-x-auto m-0">
                        <code className={`${className} block !p-4 whitespace-pre font-mono text-sm`} {...props}>
                            {children}
                        </code>
                    </pre>
                </div>
            ) : (
                <code className="bg-hover px-1.5 py-0.5 rounded text-sm font-mono text-fg" {...props}>
                    {children}
                </code>
            );
        },
        p({ children }: any) {
            return <p className="mb-4 last:mb-0">{children}</p>;
        },
        /*
         * Headings carry more space above than below, so each one binds to the
         * text it introduces rather than floating between two blocks. Tailwind's
         * preflight resets every heading to inherited size and weight, so without
         * these a model's `## Heading` is indistinguishable from body text —
         * which is what made replies read as one undifferentiated wall.
         *
         * `first:mt-0` keeps a reply that opens with a heading from starting with
         * a gap.
         */
        h1({ children }: any) {
            return <h1 className="mt-6 first:mt-0 mb-3 text-lg leading-7 font-semibold text-fg">{children}</h1>;
        },
        h2({ children }: any) {
            return <h2 className="mt-6 first:mt-0 mb-2.5 text-base leading-6 font-semibold text-fg">{children}</h2>;
        },
        h3({ children }: any) {
            return <h3 className="mt-5 first:mt-0 mb-2 text-sm leading-5 font-semibold text-fg">{children}</h3>;
        },
        // h4 down to h6 share one style. Below h4 the distinctions stop being
        // legible at 14px body size, and a model that reaches for `#####` is
        // nesting deeper than the reply's width can express anyway — better they
        // all read as "minor heading" than that h5 and h6 fall back to plain body
        // text, which is what they'd do unstyled.
        h4({ children }: any) {
            return <h4 className="mt-4 first:mt-0 mb-1.5 text-sm leading-5 font-semibold text-fg-secondary">{children}</h4>;
        },
        h5({ children }: any) {
            return <h5 className="mt-4 first:mt-0 mb-1.5 text-sm leading-5 font-semibold text-fg-secondary">{children}</h5>;
        },
        h6({ children }: any) {
            return <h6 className="mt-4 first:mt-0 mb-1.5 text-sm leading-5 font-semibold text-fg-secondary">{children}</h6>;
        },
        ul({ children }: any) {
            // mb-4 separates the list from whatever follows it; without it a
            // trailing paragraph butts straight against the last item.
            return <ul className="list-disc list-outside ms-6 mt-0 mb-4 last:mb-0 space-y-2">{children}</ul>;
        },
        ol({ children }: any) {
            return <ol className="list-decimal list-outside ms-6 mt-0 mb-4 last:mb-0 space-y-2">{children}</ol>;
        },
        li({ children }: any) {
            return <li className="ps-1 leading-[22px]">{children}</li>;
        },
        /*
         * A divider means "new topic", so it needs enough room on both sides to
         * read as a break rather than an underline on the paragraph above it.
         */
        hr() {
            return <hr className="my-6 border-0 border-t border-line" />;
        },
        blockquote({ children }: any) {
            return (
                <blockquote className="my-4 border-l-2 border-line-strong ps-4 text-fg-secondary">
                    {children}
                </blockquote>
            );
        },
        a({ children, href }: any) {
            return (
                <a href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2 decoration-fg-faint hover:decoration-fg-secondary">
                    {children}
                </a>
            );
        },
        strong({ children }: any) {
            return <strong className="font-semibold text-fg">{children}</strong>;
        },
        table({ children }: any) {
            return (
                <div className="overflow-x-auto my-4">
                    <table className="min-w-full border-collapse border border-line-strong">{children}</table>
                </div>
            );
        },
        th({ children }: any) {
            return <th className="border border-line-strong bg-hover px-4 py-2 text-left font-semibold">{children}</th>;
        },
        td({ children }: any) {
            return <td className="border border-line-strong px-4 py-2">{children}</td>;
        },
    };

    return (
        <div className="group flex flex-col items-start gap-4 w-full">
            {/* Tool cards, above the answer they informed. Each is keyed by its
                call id, so a card updates in place from approval → running → result
                rather than remounting. */}
            {toolCalls && toolCalls.length > 0 && (
                <div className="flex flex-col gap-2 w-full">
                    {toolCalls.map(tc => (
                        <ToolCallCard
                            key={tc.callId}
                            tool={tc.tool}
                            toolName={tc.toolName}
                            server={tc.server}
                            arguments={tc.arguments}
                            status={tc.status}
                            result={tc.result}
                            isError={tc.isError}
                            decision={tc.decision}
                            onApprove={onApprove ? (d) => onApprove(tc.callId, d) : undefined}
                        />
                    ))}
                </div>
            )}

            {/* Answer body — 14px like the sidebar rows, but roomier 22px leading
                for reading. `md-body` carries the structural spacing that can't be
                expressed per-component: nesting depends on where an element sits,
                not what it is. It replaces `prose prose-zinc`, which was doing
                nothing at all — @tailwindcss/typography isn't installed, so those
                classes never matched a rule. */}
            {/* Skipped when empty (a tool-only turn, or before the first token) so
                the gap above the tool cards doesn't double up on an empty block. */}
            {answer && (
                <div className="md-body text-sm leading-[22px] break-words w-full text-fg">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeHighlight, rehypeRaw]}
                        components={markdownComponents}
                    >
                        {answer}
                    </ReactMarkdown>
                </div>
            )}

            {/* Action row — timer, replay, copy, branch (14px, Neutral/950). Reveals on hover, like the user message. */}
            <div className={`flex items-center gap-2 transition-opacity duration-200 ${isComplete ? "opacity-0 group-hover:opacity-100" : "opacity-0 pointer-events-none"}`}>
                <div className="flex items-center gap-1">
                {/* Timer reveals how long the response took and what it cost. */}
                <div className="relative group/timer flex items-center">
                    {/* Disabled buttons don't reliably take :hover, so drive the
                        wash from the wrapper the tooltip already hangs off. */}
                    <button className={`${ACTION_BUTTON_CLASS} group-hover/timer:bg-hover/70`} disabled>
                        <TimerGlyph size={14} color="rgb(var(--fg))" />
                    </button>
                    <div className="pointer-events-none absolute top-full left-0 mt-1 hidden group-hover/timer:block whitespace-nowrap rounded-md bg-inverse px-2 py-1 text-xs leading-4 text-inverse-fg shadow-lg z-20">
                        {summary ?? "No timing recorded"}
                    </div>
                </div>
                <button
                    className={ACTION_BUTTON_CLASS}
                    title="Regenerate"
                    onClick={() => onRegenerate && timestamp && onRegenerate(timestamp)}
                >
                    <ReplayGlyph size={14} color="rgb(var(--fg))" />
                </button>
                <button
                    className={`${ACTION_BUTTON_CLASS} relative`}
                    title={copied ? "Copied" : "Copy"}
                    onClick={handleCopy}
                >
                    <ContentCopyGlyph size={14} color="rgb(var(--fg))" />
                    <CopiedBubble show={copied} />
                </button>
                <button
                    className={ACTION_BUTTON_CLASS}
                    title="Branch from here"
                    onClick={() => onBranch && timestamp && onBranch(timestamp)}
                >
                    <ArrowSplitGlyph size={14} color="rgb(var(--fg))" />
                </button>
                </div>
                {/* Matches the user message's action row. */}
                {timestamp && (
                    <span className="text-xs leading-4 text-fg-faint whitespace-nowrap">{formatRelativeTime(timestamp)}</span>
                )}
            </div>
        </div>
    );
}

export default memo(AIChatView);
