// The shared-chat file format, in both directions.
//
// Export and import have to agree exactly, and the only way to guarantee that is
// for one module to own the shape. Sharing wrote this format inline before there
// was anything to read it back; now that Import exists, a change to the headings
// on one side would silently break the other.
//
// Markdown rather than JSON because a shared chat is something a person reads:
// it opens fine in any editor, and someone who never installs Scarlettt still
// gets a legible conversation.

const USER_LABEL = "You";
const ASSISTANT_LABEL = "Scarlettt";

/**
 * Written between chats in a file that holds several. It's there for the person
 * reading the document — the `#` headings are what carry the structure — but see
 * `stripTrailingRule`: splitting on headings hands the rule back to the chat
 * above it, so the parser has to know about it too.
 */
const SECTION_RULE = "\n\n---\n\n";

export interface TranscriptMessage {
    role: string;
    content: string;
}

export interface ParsedChat {
    title: string;
    messages: TranscriptMessage[];
}

export interface ParsedChatFile {
    /**
     * Set when the file is a shared folder rather than a single chat. Sharing a
     * folder writes its name as a heading with no conversation under it, which is
     * exactly what distinguishes the two shapes — no marker needed in the file.
     */
    folder?: string;
    chats: ParsedChat[];
}

export function formatTranscript(messages: TranscriptMessage[]): string {
    return messages
        .map(m => `## ${m.role === "user" ? USER_LABEL : ASSISTANT_LABEL}\n\n${m.content}`)
        .join("\n\n");
}

export interface ExportChat {
    title: string;
    messages: TranscriptMessage[];
}

/**
 * Writes one document holding any number of chats. Passing `folder` puts its name
 * above them as a bare heading, which is exactly what `parseChatFile` reads back
 * as a folder — so a shared folder returns as a folder.
 *
 * Chats with no messages are left out, and not for tidiness: a `#` heading with
 * nothing under it *is* the folder marker, so a single empty chat in a multi-chat
 * file would import every chat after it into a folder named after it. Returns ""
 * when nothing survives that, so callers can say so rather than write a file that
 * reads back as nothing.
 */
export function formatChatBundle(chats: ExportChat[], folder?: string): string {
    const bodies = chats
        .filter(chat => chat.messages.length > 0)
        .map(chat => `# ${chat.title}\n\n${formatTranscript(chat.messages)}`);
    if (bodies.length === 0) return "";
    return `${folder ? `# ${folder}\n\n` : ""}${bodies.join(SECTION_RULE)}\n`;
}

/**
 * Splits on headings that are genuinely headings.
 *
 * A conversation about Markdown — or any reply containing a fenced code block
 * with a comment like `## You` — would otherwise be torn apart at exactly the
 * lines that aren't structure. Tracking fences is the difference between a format
 * that survives real chat content and one that only survives the happy path.
 */
function splitOnHeadings(markdown: string): Array<{ heading: string; body: string }> {
    const sections: Array<{ heading: string; body: string }> = [];
    let current: { heading: string; body: string[] } | null = null;
    let inFence = false;

    for (const line of markdown.split(/\r?\n/)) {
        if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

        const heading = !inFence && /^(#{1,2})\s+(.*)$/.exec(line);
        if (heading) {
            if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });
            current = { heading: line.trim(), body: [] };
            continue;
        }
        if (current) current.body.push(line);
    }
    if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });
    return sections;
}

/**
 * Removes the `---` a multi-chat file leaves at the end of a chat's last message.
 *
 * The rule sits *between* chats, so splitting on headings hands it to the message
 * above it. Left in, every trip through a shared folder or a shared selection
 * grows another rule on that reply.
 *
 * Skipped when the body's code fences don't balance, so a reply that genuinely
 * ends in `---` inside a block keeps it.
 */
function stripTrailingRule(body: string): string {
    const fences = body.match(/^\s*(?:```|~~~)/gm)?.length ?? 0;
    if (fences % 2 !== 0) return body;
    return body.replace(/\n\s*-{3,}\s*$/, "").trimEnd();
}

/**
 * Reads a shared file back into chats.
 *
 * Returns an array because sharing a *project* bundles several conversations into
 * one document, and dropping all but the first would lose chats without saying so.
 * A single shared chat simply yields one entry.
 */
export function parseChatFile(markdown: string): ParsedChatFile {
    const sections = splitOnHeadings(markdown);
    const chats: ParsedChat[] = [];
    let current: ParsedChat | null = null;
    let folder: string | undefined;

    for (const { heading, body } of sections) {
        const level1 = /^#\s+(.*)$/.exec(heading);
        if (level1) {
            if (current?.messages.length) {
                chats.push(current);
            } else if (current && !folder) {
                // A heading with no conversation under it is the folder's name, not
                // a chat. Recognising it is what lets an imported folder come back
                // as a folder instead of its chats scattering into Recent chats.
                folder = current.title;
            }
            current = { title: level1[1].trim() || "Imported chat", messages: [] };
            continue;
        }

        const level2 = /^##\s+(.*)$/.exec(heading);
        if (!level2 || !current) continue;

        const label = level2[1].trim();
        // Anything that isn't the user is treated as the assistant, so a file
        // shared from a fork that renamed the assistant still imports.
        const role = label.toLowerCase() === USER_LABEL.toLowerCase() ? "user" : "assistant";
        const content = stripTrailingRule(body);
        if (content) current.messages.push({ role, content });
    }

    if (current?.messages.length) chats.push(current);
    // A lone name with nothing under it isn't a folder worth creating.
    return { folder: chats.length ? folder : undefined, chats };
}
