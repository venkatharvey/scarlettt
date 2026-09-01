/**
 * The macOS WKWebView turns on autocorrect, autocapitalize, and spellcheck for every
 * text field by default. That's wrong for most of this app's inputs — it "corrects"
 * model names in search, capitalises search terms, and underlines JSON in the config
 * editor. Spread the right set onto a field rather than leaving the OS defaults:
 *
 *   <input {...NO_AUTOCORRECT} … />
 *
 * A shared constant, not a global DOM observer: the observer would fire on every
 * childList mutation, including each streamed chat token, and this app is careful
 * about work on that path.
 *
 * Note: OS-level substitutions (System Settings › Keyboard — smart quotes, text
 * replacements) sit above the web layer and can't be switched off from here. The
 * chat composer (`ChatInput`) sets its own props inline, on purpose — it's prose and
 * keeps spellcheck on.
 */

/** Non-prose fields — search boxes, the config editor, a rename, a secret. Nothing is
 *  rewritten, capitalised, or underlined. */
export const NO_AUTOCORRECT = {
    autoCorrect: "off",
    autoCapitalize: "off",
    spellCheck: false,
} as const;

/** Prose fields — a chat message being written or edited. Don't rewrite or capitalise,
 *  but still underline typos, matching the composer. */
export const NO_REWRITE = {
    autoCorrect: "off",
    autoCapitalize: "off",
} as const;
