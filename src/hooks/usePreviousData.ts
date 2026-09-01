import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';

/**
 * One set of conversations that "start fresh" put aside.
 *
 * Archives are siblings of the app data dir and nothing records where they went, so
 * `id` is the bare directory name and the only handle there is. `archived_at` is
 * parsed out of that name, because it is the only timestamp that exists.
 */
export interface ArchivedData {
    id: string;
    /** Unix seconds. */
    archived_at: number;
    sessions: number;
    messages: number;
    bytes: number;
}

/** Every set aside, added up — which is how Settings offers them: as one thing. */
export interface PreviousDataSummary {
    /** How many separate times a fresh start was chosen. */
    sets: number;
    sessions: number;
    messages: number;
    bytes: number;
    /** Unix seconds of the oldest set, which is the one worth naming. */
    oldestAt: number;
}

/**
 * The archived-data offer behind Settings.
 *
 * **One offer, however many sets are on disk.** Each fresh start writes its own
 * timestamped copy, so a few reinstalls leave several — and asking which of three sets
 * to bring back is a question about this app's filing rather than about the user's
 * conversations. They are summed here and restored together.
 *
 * Restoring **merges**: the conversations are added to the ones already there, and the
 * archives are left on disk. So it destroys nothing, and restoring twice adds nothing
 * the second time — the rows are ignored on their primary keys in Rust. Deleting is
 * the only irreversible action here, which is why it is the one the page confirms.
 */
export function usePreviousData() {
    const [archives, setArchives] = useState<ArchivedData[]>([]);
    const [restoring, setRestoring] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [restored, setRestored] = useState<{ sessions: number; messages: number } | null>(null);

    const refresh = useCallback(async () => {
        try {
            setArchives(await invoke<ArchivedData[]>('list_previous_data'));
        } catch (e) {
            console.error('Failed to list previous data:', e);
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const restore = useCallback(async () => {
        setRestoring(true);
        setError(null);
        setRestored(null);
        try {
            const [sessions, messages] = await invoke<[number, number]>('restore_previous_data');
            setRestored({ sessions, messages });
            // The sidebar is a separate component with its own loaded list, and it
            // already listens for this — the same event a chat import dispatches.
            // Without it the conversations are in the database and nowhere on screen.
            window.dispatchEvent(new CustomEvent('scarlettt:chat-imported'));
            await refresh();
        } catch (e) {
            setError(String(e));
        } finally {
            setRestoring(false);
        }
    }, [refresh]);

    const remove = useCallback(async () => {
        setDeleting(true);
        setError(null);
        try {
            await invoke('delete_previous_data');
            await refresh();
        } catch (e) {
            setError(String(e));
        } finally {
            setDeleting(false);
        }
    }, [refresh]);

    const summary: PreviousDataSummary | null = archives.length === 0 ? null : {
        sets: archives.length,
        sessions: archives.reduce((total, a) => total + a.sessions, 0),
        messages: archives.reduce((total, a) => total + a.messages, 0),
        bytes: archives.reduce((total, a) => total + a.bytes, 0),
        // The list arrives newest first.
        oldestAt: archives[archives.length - 1].archived_at,
    };

    return { summary, restoring, deleting, restored, error, refresh, restore, remove };
}
