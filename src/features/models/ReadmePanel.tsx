import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * The model readme, rendered.
 *
 * Deliberately NOT the chat's `markdownComponents`. That map is written for a
 * local model's own output and passes `rehypeRaw`, which turns raw HTML into live
 * elements. This content is scraped from a third party, so the plugin list here is
 * `remarkGfm` + `rehypeHighlight` and nothing else: react-markdown's default
 * renders any raw HTML as visible text, and that default is the guarantee. Copying
 * the chat's array would have quietly reinstated the thing the Rust side strips
 * tags to prevent. `skipHtml` says the same thing twice on purpose.
 *
 * The readme also wants different components from a chat reply — no copy button on
 * every block, images dropped, links that don't navigate the app away — so a
 * shared component would have been a shared map plus three overrides, which is
 * more coupling than duplication.
 */

/** Module-level so the arrays aren't rebuilt per render. Note this is *not* what
 *  prevents re-parsing — react-markdown's default export has no memo and re-runs
 *  its whole pipeline on every render regardless. The `memo` below is the fix. */
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

/** Bounded so a 17k-character readme doesn't bury the spec rows above it. */
const COLLAPSED_MAX_HEIGHT = 360;

const components = {
    /**
     * External links open in the browser, not in here.
     *
     * The window is chromeless and no navigation handler is installed, so a plain
     * `<a href>` navigates the webview off the SPA with no back button and no way
     * to return short of relaunching. `openUrl` needs no new permission —
     * `opener:default` already grants http/https.
     */
    a({ href, children }: any) {
        const external = typeof href === "string" && /^https?:/i.test(href);
        return (
            <a
                href={href}
                className="text-fg underline decoration-line-strong hover:decoration-fg-muted"
                onClick={(e) => {
                    e.preventDefault();
                    if (external) openUrl(href).catch(() => { /* nothing to offer if the shell refuses */ });
                }}
            >
                {children}
            </a>
        );
    },

    /**
     * Images are named, not shown. `img-src 'self' data: blob:` blocks remote ones
     * and ollama.com's are root-relative, so they'd 404 here either way — but they
     * are real content, not decoration: their alt text reads "Chatbot Arena ELO
     * Score", "Phi-4 benchmark". qwen2.5-coder's readme is almost entirely charts,
     * and silently dropping them would leave its headings with nothing under them.
     */
    img({ alt }: any) {
        return (
            <span className="my-2 flex items-center gap-2 rounded border border-dashed border-line-strong px-3 py-2 text-xs leading-4 text-fg-muted">
                {alt ? `Image not shown — ${alt}` : "Image not shown"}
            </span>
        );
    },

    /** Benchmark tables run to 7 columns; they scroll themselves rather than the page. */
    table({ children }: any) {
        return (
            <div className="my-3 overflow-x-auto">
                <table className="w-full border-collapse text-xs">{children}</table>
            </div>
        );
    },
    th({ children }: any) {
        return (
            <th className="border border-line bg-hover px-2 py-1 text-left font-medium whitespace-nowrap">
                {children}
            </th>
        );
    },
    td({ children }: any) {
        return <td className="border border-line px-2 py-1 align-top">{children}</td>;
    },

    code({ className, children, ...props }: any) {
        const text = String(children ?? "");
        const isBlock = /language-/.test(className ?? "") || text.includes("\n");
        // The inset lives on the <code>, never the <pre>: highlight.js ships
        // `pre code.hljs { padding: 1em }`, so padding both gives 32px and a
        // two-tone frame. `!p-3` because that compound selector out-specifies a
        // plain utility. Same rule as the chat — see AIChatView.
        return isBlock ? (
            <code className={`${className ?? ""} block !p-3 whitespace-pre font-mono text-xs`} {...props}>
                {children}
            </code>
        ) : (
            <code className="rounded bg-hover px-1 py-0.5 font-mono text-xs text-fg" {...props}>
                {children}
            </code>
        );
    },
    pre({ children }: any) {
        return (
            <pre className="my-3 overflow-x-auto rounded-lg bg-zinc-900 text-zinc-100">{children}</pre>
        );
    },

    h1: ({ children }: any) => <h2 className="mt-4 mb-1.5 text-sm font-medium text-fg">{children}</h2>,
    h2: ({ children }: any) => <h3 className="mt-4 mb-1.5 text-sm font-medium text-fg">{children}</h3>,
    h3: ({ children }: any) => <h4 className="mt-3 mb-1 text-xs font-medium text-fg">{children}</h4>,
    p: ({ children }: any) => <p className="my-2">{children}</p>,
    ul: ({ children }: any) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
    ol: ({ children }: any) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
    blockquote: ({ children }: any) => (
        <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-fg-muted">{children}</blockquote>
    ),
    hr: () => <hr className="my-3 border-line" />,
};

/**
 * `memo` is load-bearing, not tidiness. ModelDetailPage re-renders on every
 * download-progress event, and react-markdown re-parses on every render — a 17k
 * readme with two large tables would re-parse on each progress tick. CLAUDE.md
 * records what unmemoised markdown cost in the chat: 4,188ms of blocking.
 */
function ReadmePanel({ markdown }: { markdown: string }) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs leading-4 text-fg-secondary">Readme</p>
            {/* Its own card against the pane, so it reads as a document rather than
                one more spec row. White on the #f5f5f5 pane, matching the panels
                elsewhere in the app. */}
            <div className="rounded-lg border border-line bg-card">
                <div
                    className="relative overflow-hidden"
                    style={expanded ? undefined : { maxHeight: COLLAPSED_MAX_HEIGHT }}
                >
                    {/* `md-body` carries the list and nested-list spacing that
                        per-component classNames can't express — see src/css/index.css. */}
                    <div className="md-body px-4 py-3 text-xs leading-5 text-fg-secondary break-words">
                        <ReactMarkdown
                            remarkPlugins={REMARK_PLUGINS}
                            rehypePlugins={REHYPE_PLUGINS}
                            skipHtml
                            components={components}
                        >
                            {markdown}
                        </ReactMarkdown>
                    </div>
                    {!expanded && (
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" />
                    )}
                </div>
                <button
                    className="w-full border-t border-line px-4 py-2 text-left text-xs leading-4 text-fg-secondary transition-colors hover:bg-hover"
                    onClick={() => setExpanded(v => !v)}
                >
                    {expanded ? "Show less" : "Show more"}
                </button>
            </div>
        </div>
    );
}

export default memo(ReadmePanel);
