import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
    subscribe, getNotices, dismiss, notify, Notice, NoticeAction,
    IMPORT_FAILED_NOTICE,
} from "./notices";
import { APP_INSET } from "../../layout";

interface NoticeHostProps {
    /** Opens the models library, optionally on a model's page or a search. */
    onAction: (action: NoticeAction) => void;
}

/**
 * A toast's three beats, in order: it slides in, it sits there for five seconds, it
 * slides out. Every one of these is applied to the CSS *inline*, so the animation and
 * the timer that follows it are driven by one number rather than two that can drift.
 *
 * The five seconds start **after** the entrance, not with it. Sharing a start meant
 * the bar was already emptying while the card was still moving, so the time actually
 * available to read it was less than the bar claimed.
 */
const ENTER_MS = 260;
const VISIBLE_MS = 5_000;
const EXIT_MS = 220;

/**
 * One notice in the banner strip.
 *
 * Toasts render their own, smaller shape below — a countdown, a title, a description
 * and one acknowledgement. They started out sharing this markup, but a banner offers
 * a way to fix a blocked state while a toast only reports something that already
 * happened, so the two ended up with different anatomy rather than a shared one with
 * branches through it.
 */
function NoticeCard({ notice, onAction, className }: {
    notice: Notice;
    onAction: (action: NoticeAction) => void;
    className: string;
}) {
    return (
        <div className={`flex items-start gap-3 p-3 rounded-lg ${className}`}>
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <p className="text-sm leading-[18px] text-fg">{notice.title}</p>
                {notice.body && (
                    <p className="text-xs leading-4 text-fg-secondary">{notice.body}</p>
                )}
            </div>
            {notice.action && (
                <button
                    className="flex-shrink-0 px-2 py-1 rounded bg-inverse text-inverse-fg text-xs leading-4 transition-colors hover:bg-inverse-hover"
                    onClick={() => {
                        // Dismissed on action: the notice describes a state the
                        // user is now on their way to fixing, and leaving it up
                        // while they do would keep asserting something stale.
                        onAction(notice.action!);
                        dismiss(notice.id);
                    }}
                >
                    {notice.actionLabel ?? "Fix"}
                </button>
            )}
            <button
                className="flex-shrink-0 px-2 py-1 rounded text-xs leading-4 text-fg-secondary transition-colors hover:bg-inverse/5"
                onClick={() => dismiss(notice.id)}
            >
                Dismiss
            </button>
        </div>
    );
}

/**
 * Renders app-level notices, in one of two places.
 *
 * Mounted in `App` rather than inside a page: these outlive the page that raised
 * them, and acting on one navigates away from it. Stacked rather than queued —
 * two unrelated problems are two things the user needs to know, and hiding one
 * behind the other would make the second look like it never happened.
 *
 * **Banners** are in flow above the pane, so they push the view down: right for a
 * state that blocks what the user was doing. **Toasts** are fixed in the top-right
 * and expire on their own: right for something that already happened and needs no
 * response. The two containers are guarded separately — sharing one guard meant the
 * banner strip's `pt-3` added 12px of dead space above the view whenever only a
 * toast was up.
 */
export default function NoticeHost({ onAction }: NoticeHostProps) {
    const notices = useSyncExternalStore(subscribe, getNotices);
    const banners = notices.filter(n => n.placement !== "toast");
    const toasts = notices.filter(n => n.placement === "toast");

    // The import failure was already being dispatched with nothing listening, so
    // a failed import reported itself to no one. Bridged here rather than moved,
    // so the sidebar keeps its one-line dispatch.
    useEffect(() => {
        const onImportFailed = () => notify({
            id: IMPORT_FAILED_NOTICE,
            title: "That chat couldn't be imported.",
            body: "The file may not be a chat export, or may be from a format this app doesn't read yet.",
        });
        window.addEventListener("scarlettt:chat-import-failed", onImportFailed);
        return () => window.removeEventListener("scarlettt:chat-import-failed", onImportFailed);
    }, []);

    /**
     * Toasts on their way out.
     *
     * A notice is removed from the store only *after* its exit animation, because
     * removing it first unmounts the card and there is nothing left to animate. So
     * leaving is a state of its own, held here rather than in the store — the store
     * describes what is true, not what is mid-transition.
     */
    const [leaving, setLeaving] = useState<string[]>([]);

    const startLeaving = useCallback((id: string) => {
        setLeaving(prev => (prev.includes(id) ? prev : [...prev, id]));
        window.setTimeout(() => {
            dismiss(id);
            setLeaving(prev => prev.filter(other => other !== id));
        }, EXIT_MS);
    }, []);

    // Toasts expire. Keyed on the ids rather than the array, which is rebuilt on
    // every store emit — depending on the array itself would restart the countdown
    // each time any unrelated notice changed.
    const toastIds = toasts.map(n => n.id).join("|");
    useEffect(() => {
        if (!toastIds) return;
        const timers = toastIds.split("|").map(id =>
            // Entrance first, then the five seconds it promises.
            window.setTimeout(() => startLeaving(id), ENTER_MS + VISIBLE_MS)
        );
        return () => timers.forEach(timer => window.clearTimeout(timer));
    }, [toastIds, startLeaving]);

    if (notices.length === 0) return null;

    return (
        <>
            {banners.length > 0 && (
                <div className="flex flex-col gap-2 px-4 pt-3">
                    {banners.map(notice => (
                        <NoticeCard
                            key={notice.id}
                            notice={notice}
                            onAction={onAction}
                            className="border border-warn-line bg-warn-bg"
                        />
                    ))}
                </div>
            )}

            {toasts.length > 0 && (
                // Fixed to the window, not the pane: nothing on the ancestor chain
                // creates a containing block, and the traffic-light cluster is in the
                // opposite corner. Inset by APP_INSET so it lines up with the shell's
                // own margins rather than sitting flush against the glass.
                <div
                    className="fixed z-50 flex flex-col gap-2 items-end"
                    style={{ top: APP_INSET, right: APP_INSET }}
                >
                    {toasts.map(notice => {
                        const isLeaving = leaving.includes(notice.id);
                        return (
                        <div
                            key={notice.id}
                            className={`${isLeaving ? "toast-leave" : "toast-enter"} w-[300px] overflow-hidden rounded-lg border border-line bg-card`}
                            style={{ animationDuration: `${isLeaving ? EXIT_MS : ENTER_MS}ms` }}
                        >
                            {/* The countdown, across the top. It is the only thing
                                that makes a disappearing message honest: something is
                                about to go, and here is how long you have. Delayed by
                                the entrance so it starts full and only begins draining
                                once the card has arrived. */}
                            <div className="h-0.5 w-full bg-hover">
                                <div
                                    className="toast-timer h-full bg-inverse"
                                    style={{
                                        animationDuration: `${VISIBLE_MS}ms`,
                                        animationDelay: `${ENTER_MS}ms`,
                                    }}
                                />
                            </div>
                            <div className="flex flex-col gap-1 p-3">
                                <p className="text-sm leading-[18px] text-fg">{notice.title}</p>
                                {notice.body && (
                                    <p className="text-xs leading-4 text-fg-secondary">{notice.body}</p>
                                )}
                                <button
                                    className="self-start mt-1 px-2 py-1 rounded bg-inverse text-inverse-fg text-xs leading-4 transition-colors hover:bg-inverse-hover"
                                    // Leaves the same way it arrived rather than
                                    // blinking out, so acknowledging it and letting it
                                    // expire look like the same thing happening.
                                    onClick={() => startLeaving(notice.id)}
                                >
                                    Got it
                                </button>
                            </div>
                        </div>
                        );
                    })}
                </div>
            )}
        </>
    );
}
