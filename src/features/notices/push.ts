import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from "@tauri-apps/plugin-notification";
import { splitThinking } from "../chat/thinking";

/**
 * Native macOS notifications, for things that finish while you're somewhere else.
 *
 * These are **local** notifications, not APNs — nothing leaves the machine, and no
 * server is involved. The in-app banners and toasts in `notices.ts` are unchanged
 * and still handle everything while the window is in front; this is the sibling that
 * covers the case where nobody is looking.
 *
 * The rule that makes the two coexist: **nothing fires while the window is
 * focused.** A notification for something that just visibly happened on screen is
 * noise, and it would double up with the toast that already says it.
 */

/** Which kinds exist, and which modes they can occur in. */
export type PushKind = "reply" | "error" | "context" | "update";

/**
 * Whether the app window has focus.
 *
 * Plain DOM focus rather than Tauri's `onFocusChanged`, for two reasons: it is the
 * same answer (the webview *is* the window's content, so it loses focus exactly when
 * the app does), and it works in the browser preview, where the Tauri window API
 * would need its own mock. `document.hasFocus()` is read at fire time rather than
 * tracked in a variable, so there is no stale state to get wrong.
 */
function windowHasFocus(): boolean {
    try {
        return document.hasFocus();
    } catch {
        // If it can't be determined, assume the user IS looking. The failure mode
        // then is a missed notification rather than an unwanted one, and an
        // interruption you didn't want is the more costly of the two.
        return true;
    }
}

/**
 * macOS asks on first use, and the answer sticks.
 *
 * Requested lazily — at the moment there is something to say — rather than at
 * launch. A permission prompt during onboarding, before the user has seen a single
 * reply, is asking about a feature they have no way to evaluate yet.
 */
async function ensurePermission(): Promise<boolean> {
    try {
        if (await isPermissionGranted()) return true;
        return (await requestPermission()) === "granted";
    } catch (error) {
        console.error("Notification permission check failed:", error);
        return false;
    }
}

/**
 * Whether macOS will actually deliver notifications.
 *
 * Read by Settings so the toggle can't claim to be on while the OS is silently
 * dropping everything — a switch that lies is worse than no switch. This only
 * *checks*; it never prompts, so opening Settings can't trigger the system dialog.
 */
export async function pushPermissionGranted(): Promise<boolean> {
    try {
        return await isPermissionGranted();
    } catch {
        return false;
    }
}

/**
 * Raises a notification, if it should be raised.
 *
 * `enabled` is passed in rather than read here so this module stays free of the
 * settings store — the caller already has it, and one source of truth for the
 * setting is better than two readers that can disagree.
 *
 * Never throws. A notification failing is not worth turning into an error the user
 * has to deal with on top of whatever they were already told.
 */
export async function pushNotify(
    enabled: boolean,
    kind: PushKind,
    title: string,
    body: string,
): Promise<void> {
    if (!enabled) return;
    if (windowHasFocus()) return;
    try {
        if (!(await ensurePermission())) return;
        sendNotification({ title, body });
    } catch (error) {
        console.error(`Failed to raise the ${kind} notification:`, error);
    }
}

/**
 * A reply the user wasn't watching, trimmed to a line.
 *
 * **Reasoning is stripped first**, and that is not cosmetic. Models that inline
 * their thinking open with `<think>`, so without this the notification body was
 * literally `<think>` — caught by the first end-to-end test of this path. Worse,
 * for a model whose reasoning runs before its answer, the notification would have
 * shown the reasoning itself: the one thing the app deliberately never displays and
 * never stores (see the streaming section of CLAUDE.md). `splitThinking` exists
 * precisely to remove those tags, and this is a third place that has to use it.
 *
 * The first *line* rather than the first N characters, because a reply that opens
 * with a heading or a code fence would otherwise put markdown syntax in the body.
 */
export function replyPreview(content: string): string {
    const { answer } = splitThinking(content);
    const firstLine = answer
        .split("\n")
        .map(line => line.trim())
        .find(line => line.length > 0 && !line.startsWith("```")) ?? "";
    const cleaned = firstLine.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim();
    // A reply that is nothing but reasoning reduces to nothing, and a notification
    // with an empty body reads as a bug. Say that something arrived instead.
    if (!cleaned) return "Tap to read the reply.";
    return cleaned.length > 120 ? `${cleaned.slice(0, 119)}…` : cleaned;
}
