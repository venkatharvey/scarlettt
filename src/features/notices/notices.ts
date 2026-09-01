// App-level notices, kept outside React so they outlive the page that raised them.
//
// ChatPage unmounts whenever Settings or the models library opens, so a notice
// held in its state would vanish exactly when the user acts on it — following the
// "install the missing model" link would dismiss the message explaining why. Same
// reasoning as `activeStreams`: the thing being reported outlives the component
// that noticed it.
//
// Nothing in this store auto-dismisses. These report states that block what the user
// was doing — a chat with no model can't work at all — so a message that fades leaves
// them stuck with the explanation gone. They clear when acted on or dismissed.
//
// `placement: "toast"` is the one exception, and only in the renderer: a toast reports
// something that already succeeded rather than something blocking, so `NoticeHost`
// gives it a lifetime. The store stays timer-free.

export type NoticeAction =
    /** Open the models library, on this model's page when it has one. */
    | { kind: "install"; model: string }
    /** Open the models library with the search box primed — for a name Ollama's
     *  library doesn't have, where a detail page would render empty. */
    | { kind: "search"; query: string };

export interface Notice {
    /** Stable per kind of problem, so re-raising it replaces rather than stacks. */
    id: string;
    title: string;
    body?: string;
    action?: NoticeAction;
    actionLabel?: string;
    /**
     * Where this renders. Absent is the full-width amber banner above the pane, which
     * pushes the view down — right for something blocking. `"toast"` is a card in the
     * top-right corner that fades on its own, for something that merely happened.
     */
    placement?: "toast";
}

const notices = new Map<string, Notice>();
const listeners = new Set<() => void>();
/** Recreated on change so `useSyncExternalStore` sees a new identity. */
let snapshot: Notice[] = [];

function emit() {
    snapshot = [...notices.values()];
    listeners.forEach(listener => listener());
}

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getNotices(): Notice[] {
    return snapshot;
}

/** Raise a notice, replacing any earlier one with the same id. */
export function notify(notice: Notice): void {
    const existing = notices.get(notice.id);
    // Identical re-raises are ignored: the missing-model check runs on every
    // ChatPage mount and on every memory poll, and re-emitting would restart any
    // enter animation on each one.
    if (existing && JSON.stringify(existing) === JSON.stringify(notice)) return;
    notices.set(notice.id, notice);
    emit();
}

export function dismiss(id: string): void {
    if (notices.delete(id)) emit();
}

export const MISSING_MODEL_NOTICE = "missing-model";
export const IMPORT_FAILED_NOTICE = "chat-import-failed";
/** Raised when every chat a share was asked for turns out to have no messages. */
export const SHARE_EMPTY_NOTICE = "share-empty";
/** Raised after a fresh start, to say where the previous conversations went. */
export const PREVIOUS_DATA_ARCHIVED_NOTICE = "previous-data-archived";
