// Some reasoning models wrap their scratchpad in <think>…</think> inside the normal
// content stream. The app doesn't display reasoning, so this exists only to *remove*
// it — from what's rendered as the answer, and from the history sent back to the
// model. Without that, those tags would show up as literal text in a reply and be
// resent on every later turn.
//
// Models that return reasoning in Ollama's separate `thinking` field never reach
// this: it isn't deserialised, so it never enters the content stream at all.

const OPEN = "<think>";
const CLOSE = "</think>";

export interface SplitMessage {
    thinking: string;
    answer: string;
}

/**
 * Separates the reasoning block from the answer. Mid-stream the closing tag
 * hasn't arrived yet, which is not malformed — it means everything so far is
 * still reasoning and the answer is empty.
 */
export function splitThinking(msg: string): SplitMessage {
    const open = msg.indexOf(OPEN);
    if (open === -1) return { thinking: "", answer: msg };

    const close = msg.indexOf(CLOSE);
    if (close === -1) {
        return { thinking: msg.substring(open + OPEN.length).trim(), answer: "" };
    }
    return {
        thinking: msg.substring(open + OPEN.length, close).trim(),
        answer: msg.substring(close + CLOSE.length).trim(),
    };
}
