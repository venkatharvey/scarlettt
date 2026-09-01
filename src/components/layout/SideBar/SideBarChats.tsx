import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { NO_AUTOCORRECT } from "../../../inputProps";
import { createPortal } from "react-dom";
import { ask, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import SearchGlyph from "../../../svg/SearchGlyph";
import MoreHoriz from "../../../svg/MoreHoriz";
import Folder from "../../../svg/Folder";
import Add from "../../../svg/Add";
import Check from "../../../svg/Check";
import ArrowSplitGlyph from "../../../svg/chat/ArrowSplitGlyph";
import { formatChatBundle, ExportChat } from "../../../features/chat/transcript";
import { notify, SHARE_EMPTY_NOTICE } from "../../../features/notices/notices";
import { useChatStorage, ChatSession } from "../../../hooks/useChatStorage";
import { usePinnedSessions, MAX_PINNED_SESSIONS } from "../../../hooks/usePinnedSessions";
import { useProjects, Project } from "../../../hooks/useProjects";

/**
 * Where the selection bar is rendered: an element the sidebar shell puts at the
 * foot of the panel, above Settings. Declared here because this component owns
 * the bar; provided there because that position is outside this component's
 * subtree — and, more to the point, outside the scrolling list.
 */
export const SELECTION_BAR_SLOT_ID = "scarlettt-selection-bar";

const PINNED_PREVIEW_COUNT = 5;
const RECENT_PREVIEW_COUNT = 20;
const PROJECT_PREVIEW_COUNT = 5;

/** Shared style for the section's text buttons — "View all", "+ New chat". */
const TEXT_BUTTON_CLASS = "text-xs leading-4 text-fg-secondary text-left";

/**
 * How many extra rows one "View all" click reveals. The step grows with the
 * library so long histories don't need dozens of clicks to page through.
 */
function loadStep(totalChats: number) {
    if (totalChats >= 100) return 20;
    if (totalChats >= 50) return 10;
    return 5;
}

const MENU_WIDTH = 160;
const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

const HEADING_CLASS = "px-2 text-xs leading-4 text-fg-secondary";
const ROW_CLASS = "group relative flex items-center gap-2 p-2 rounded cursor-pointer";
const MENU_ITEM_CLASS = "w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-hover";

/** The selection bar's two actions. `flex-1` so they split the sidebar's width
 *  evenly — it can be dragged down to 200px, where a text label plus padding is
 *  most of what fits on a line. */
const SELECTION_ACTION_CLASS =
    "flex-1 px-2 py-1 rounded text-xs leading-4 transition-colors disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Rows live in a scrolling, overflow-hidden column, so an absolutely positioned
 * menu gets clipped on the last few of them. This places a portalled popover
 * from the trigger's rect instead, then clamps it into the viewport once its
 * real height is known — the height varies with contents, so it isn't a constant.
 */
function useRowMenu() {
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const triggerRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const isOpen = pos !== null;

    const close = useCallback(() => setPos(null), []);

    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node;
            if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
            close();
        };
        document.addEventListener("mousedown", handleClickOutside);
        // Fixed positioning doesn't follow the list, so dismiss rather than drift.
        window.addEventListener("scroll", close, true);
        window.addEventListener("resize", close);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            window.removeEventListener("scroll", close, true);
            window.removeEventListener("resize", close);
        };
    }, [isOpen, close]);

    useLayoutEffect(() => {
        const el = menuRef.current;
        if (!pos || !el) return;
        const highest = window.innerHeight - VIEWPORT_MARGIN - el.offsetHeight;
        const clamped = Math.max(VIEWPORT_MARGIN, Math.min(pos.top, highest));
        if (clamped !== pos.top) setPos({ ...pos, top: clamped });
    });

    const toggle = () => {
        if (isOpen) {
            close();
            return;
        }
        const rect = triggerRef.current?.getBoundingClientRect();
        if (!rect) return;
        setPos({
            top: rect.bottom + MENU_GAP,
            left: Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN),
        });
    };

    return { pos, isOpen, close, toggle, triggerRef, menuRef };
}

/** The `⋯` trigger — invisible until the row is hovered or its menu is open. */
function MenuTrigger({ isOpen, onToggle, innerRef, hidden }: {
    isOpen: boolean;
    onToggle: () => void;
    innerRef: React.RefObject<HTMLDivElement | null>;
    hidden?: boolean;
}) {
    return (
        <div
            ref={innerRef}
            className={`flex-shrink-0 flex items-center justify-center w-4 h-4 rounded transition-opacity ${isOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"} ${hidden ? "hidden" : ""}`}
            onClick={(e) => {
                e.stopPropagation();
                onToggle();
            }}
        >
            <MoreHoriz size={16} color="rgb(var(--fg-secondary))" />
        </div>
    );
}

function MenuPopover({ pos, innerRef, children }: {
    pos: { top: number; left: number };
    innerRef: React.RefObject<HTMLDivElement | null>;
    children: React.ReactNode;
}) {
    return createPortal(
        <div
            ref={innerRef}
            className="fixed bg-card rounded-lg shadow-lg border border-line py-1 z-50 max-h-[70vh] overflow-y-auto"
            style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
            onClick={(e) => e.stopPropagation()}
        >
            {children}
        </div>,
        document.body
    );
}

/** Shared inline-rename input, used by both chat and project rows. */
function RenameInput({ value, onChange, onCommit, onCancel }: {
    value: string;
    onChange: (next: string) => void;
    onCommit: () => void;
    onCancel: () => void;
}) {
    return (
        <input
            {...NO_AUTOCORRECT}
            autoFocus
            value={value}
            className="flex-1 min-w-0 bg-card text-sm leading-[18px] text-fg rounded border border-line-strong px-1 -mx-1 outline-none focus:border-fg-faint"
            onChange={(e) => onChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={onCommit}
            onKeyDown={(e) => {
                if (e.key === "Enter") onCommit();
                if (e.key === "Escape") onCancel();
            }}
        />
    );
}

interface SideBarChatsProps {
    isCollapsed: boolean;
    activeSessionId?: string;
    onSessionSelect: (sessionId: string) => void;
    onSearchClick?: () => void;
    sessionsRefreshTrigger?: number;
    onSessionDelete?: (sessionId: string) => void;
}

interface SessionRowProps {
    session: ChatSession;
    isActive: boolean;
    isPinned: boolean;
    canPin: boolean;
    projects: Project[];
    indented?: boolean;
    /**
     * Selection mode. The whole list enters it together — a row is never
     * selectable on its own — so while it's on, clicking any row picks it instead
     * of opening it.
     */
    selecting: boolean;
    selected: boolean;
    onSelect: () => void;
    onBeginSelect: () => void;
    onToggleSelect: () => void;
    onTogglePin: () => void;
    onRename: (title: string) => void;
    onShare: () => void;
    onMoveToProject: (projectId: string | null) => void;
    onDelete: () => void;
}

function SessionRow({
    session, isActive, isPinned, canPin, projects, indented, selecting, selected,
    onSelect, onBeginSelect, onToggleSelect, onTogglePin, onRename, onShare, onMoveToProject, onDelete,
}: SessionRowProps) {
    const { pos, isOpen, close, toggle, triggerRef, menuRef } = useRowMenu();
    const [draftTitle, setDraftTitle] = useState<string | null>(null);
    // The menu swaps to a project picker in place rather than opening a flyout.
    const [page, setPage] = useState<"main" | "projects">("main");
    const isRenaming = draftTitle !== null;

    const commitRename = () => {
        const next = draftTitle?.trim();
        if (next && next !== session.title) onRename(next);
        setDraftTitle(null);
    };

    const closeMenu = () => {
        close();
        setPage("main");
    };

    // While selecting, the highlight means "picked" and nothing else. Leaving the
    // open chat lit as well would make a row look picked when it isn't.
    const lit = selecting ? selected : isActive;

    return (
        <div
            className={`${ROW_CLASS} ${lit ? "bg-hover" : "hover:bg-hover"} ${indented ? "pl-8" : ""}`}
            onClick={isRenaming ? undefined : selecting ? onToggleSelect : onSelect}
        >
            {selecting && (
                <span className={`flex-shrink-0 flex items-center justify-center w-4 h-4 rounded-[3px] border ${selected ? "bg-inverse border-inverse" : "bg-card border-line-strong"}`}>
                    {selected && <Check size={12} color="rgb(var(--inverse-fg))" />}
                </span>
            )}
            {isRenaming ? (
                <RenameInput
                    value={draftTitle}
                    onChange={setDraftTitle}
                    onCommit={commitRename}
                    onCancel={() => setDraftTitle(null)}
                />
            ) : (
                <>
                    {/* A branch keeps its parent's title, so the glyph is the only
                        thing telling the two apart in the list. */}
                    {session.branched_from && (
                        <span className="flex-shrink-0" title="Branched from another chat">
                            <ArrowSplitGlyph size={14} color="rgb(var(--fg-muted))" />
                        </span>
                    )}
                    <p className="flex-1 min-w-0 text-sm leading-[18px] text-fg truncate">{session.title}</p>
                </>
            )}
            <MenuTrigger isOpen={isOpen} onToggle={toggle} innerRef={triggerRef} hidden={isRenaming || selecting} />

            {pos && (
                <MenuPopover pos={pos} innerRef={menuRef}>
                    {page === "main" ? (
                        <>
                            {/* First, because it's the way into an action that spans
                                several chats rather than one more thing to do to
                                this one. */}
                            <button
                                className={MENU_ITEM_CLASS}
                                onClick={() => {
                                    onBeginSelect();
                                    closeMenu();
                                }}
                            >
                                Select
                            </button>
                            {/* Kept to one line whether or not it's available, so
                                the popover doesn't change height on hover. */}
                            <button
                                disabled={!isPinned && !canPin}
                                title={!isPinned && !canPin ? `You can pin up to ${MAX_PINNED_SESSIONS} chats. Unpin one first.` : undefined}
                                className={`${MENU_ITEM_CLASS} disabled:text-fg-faint disabled:hover:bg-transparent disabled:cursor-not-allowed`}
                                onClick={() => {
                                    onTogglePin();
                                    closeMenu();
                                }}
                            >
                                {isPinned ? "Unpin" : canPin ? "Pin to top" : `Pin limit reached (${MAX_PINNED_SESSIONS})`}
                            </button>
                            <button
                                className={MENU_ITEM_CLASS}
                                onClick={() => {
                                    setDraftTitle(session.title);
                                    closeMenu();
                                }}
                            >
                                Rename
                            </button>
                            <button
                                className={MENU_ITEM_CLASS}
                                onClick={() => {
                                    onShare();
                                    closeMenu();
                                }}
                            >
                                Share
                            </button>
                            <button className={MENU_ITEM_CLASS} onClick={() => setPage("projects")}>
                                Move to folder
                            </button>
                            <button
                                className="w-full text-left px-3 py-1.5 text-sm text-bad-fg hover:bg-bad-bg"
                                onClick={() => {
                                    onDelete();
                                    closeMenu();
                                }}
                            >
                                Delete
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                className="w-full text-left px-3 py-1.5 text-xs text-fg-secondary hover:bg-hover"
                                onClick={() => setPage("main")}
                            >
                                ← Back
                            </button>
                            {projects.length === 0 && (
                                <p className="px-3 py-1.5 text-xs text-fg-faint">No folders yet</p>
                            )}
                            {projects.map((project) => (
                                <button
                                    key={project.id}
                                    disabled={session.project_id === project.id}
                                    className={`${MENU_ITEM_CLASS} truncate disabled:text-fg-faint disabled:hover:bg-transparent disabled:cursor-default`}
                                    onClick={() => {
                                        onMoveToProject(project.id);
                                        closeMenu();
                                    }}
                                >
                                    {project.name}
                                </button>
                            ))}
                            {session.project_id && (
                                <button
                                    className={MENU_ITEM_CLASS}
                                    onClick={() => {
                                        onMoveToProject(null);
                                        closeMenu();
                                    }}
                                >
                                    Remove from folder
                                </button>
                            )}
                        </>
                    )}
                </MenuPopover>
            )}
        </div>
    );
}

interface ProjectRowProps {
    project: Project;
    chatCount: number;
    isExpanded: boolean;
    startRenaming: boolean;
    onToggleExpand: () => void;
    onRename: (name: string) => void;
    onShare: () => void;
    onDelete: () => void;
    onRenameHandled: () => void;
}

function ProjectRow({
    project, chatCount, isExpanded, startRenaming,
    onToggleExpand, onRename, onShare, onDelete, onRenameHandled,
}: ProjectRowProps) {
    const { pos, isOpen, close, toggle, triggerRef, menuRef } = useRowMenu();
    const [draftName, setDraftName] = useState<string | null>(null);
    const isRenaming = draftName !== null;

    // A freshly created project opens straight into its name field.
    useEffect(() => {
        if (startRenaming) {
            setDraftName(project.name);
            onRenameHandled();
        }
    }, [startRenaming, project.name, onRenameHandled]);

    const commitRename = () => {
        const next = draftName?.trim();
        if (next && next !== project.name) onRename(next);
        setDraftName(null);
    };

    return (
        <div
            className={`${ROW_CLASS} ${isExpanded ? "bg-hover" : "hover:bg-hover"}`}
            onClick={isRenaming ? undefined : onToggleExpand}
        >
            <span className="flex-shrink-0 flex items-center justify-center w-4 h-4">
                <Folder size={16} color="rgb(var(--fg))" />
            </span>
            {isRenaming ? (
                <RenameInput
                    value={draftName}
                    onChange={setDraftName}
                    onCommit={commitRename}
                    onCancel={() => setDraftName(null)}
                />
            ) : (
                <>
                    <p className="flex-1 min-w-0 text-sm leading-[18px] text-fg truncate">{project.name}</p>
                    {chatCount > 0 && !isOpen && (
                        <span className="flex-shrink-0 text-xs text-fg-secondary group-hover:hidden">{chatCount}</span>
                    )}
                </>
            )}
            <MenuTrigger isOpen={isOpen} onToggle={toggle} innerRef={triggerRef} hidden={isRenaming} />

            {pos && (
                <MenuPopover pos={pos} innerRef={menuRef}>
                    <button
                        className={MENU_ITEM_CLASS}
                        onClick={() => {
                            setDraftName(project.name);
                            close();
                        }}
                    >
                        Rename
                    </button>
                    <button
                        className={MENU_ITEM_CLASS}
                        onClick={() => {
                            onShare();
                            close();
                        }}
                    >
                        {/* "folder", not "project". `Project` is what the data model
                            and the SQL table are called, and that name is fine in the
                            code — but the UI has said Folders everywhere since it was
                            drawn, and this was the one label where the internal word
                            reached the user. The chat menu beside it already says
                            "Move to folder". */}
                        Share folder
                    </button>
                    <button
                        className="w-full text-left px-3 py-1.5 text-sm text-bad-fg hover:bg-bad-bg"
                        onClick={() => {
                            onDelete();
                            close();
                        }}
                    >
                        Delete
                    </button>
                </MenuPopover>
            )}
        </div>
    );
}

/**
 * The selection actions, pinned at the foot of the sidebar above Settings.
 *
 * Deliberately not in the list: the chats being picked can be sections apart, and
 * anything living in the scroll container scrolls away exactly when the next chat
 * is being reached for. A rule separates it from the list above, since at the
 * panel's foot it is chrome rather than a row.
 */
function SelectionBar({ count, onShare, onMakeFolder, onCancel }: {
    count: number;
    onShare: () => void;
    onMakeFolder: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="flex flex-col gap-2 px-2 pt-3 pb-2 border-t border-line">
            <div className="flex items-center justify-between gap-2">
                <p className="text-xs leading-4 text-fg-secondary">
                    {count === 0 ? "Pick chats" : `${count} selected`}
                </p>
                <button className="text-xs leading-4 text-fg-secondary hover:text-fg" onClick={onCancel}>
                    Cancel
                </button>
            </div>
            <div className="flex items-center gap-2">
                <button
                    disabled={count === 0}
                    className={`${SELECTION_ACTION_CLASS} bg-inverse text-inverse-fg hover:bg-inverse-hover disabled:hover:bg-inverse`}
                    onClick={onShare}
                >
                    Share
                </button>
                <button
                    disabled={count === 0}
                    className={`${SELECTION_ACTION_CLASS} border border-line-strong text-fg hover:bg-hover disabled:hover:bg-transparent`}
                    onClick={onMakeFolder}
                >
                    New folder
                </button>
            </div>
        </div>
    );
}

function SideBarChats({ isCollapsed, activeSessionId, onSessionSelect, onSearchClick, sessionsRefreshTrigger, onSessionDelete }: SideBarChatsProps) {
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);
    const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
    const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
    // How many rows each section currently reveals; "View all" grows these by
    // one step at a time rather than dumping the whole history at once.
    const [pinnedLimit, setPinnedLimit] = useState(PINNED_PREVIEW_COUNT);
    const [recentLimit, setRecentLimit] = useState(RECENT_PREVIEW_COUNT);
    const [projectLimits, setProjectLimits] = useState<Record<string, number>>({});
    /**
     * Chats picked in selection mode, or `null` when not selecting at all. One
     * piece of state rather than a mode flag beside a list, so the two can never
     * disagree — and unpicking the last chat leaves the mode on, which is what
     * lets the user carry on choosing instead of starting over.
     */
    const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
    const { getSessions, getMessages, createSession, renameSession, deleteSession } = useChatStorage();
    const { getProjects, createProject, renameProject, deleteProject, setSessionProject } = useProjects();
    const { pinnedIds, togglePin, isPinned, isPinLimitReached } = usePinnedSessions();

    const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
    useEffect(() => { setBarSlot(document.getElementById(SELECTION_BAR_SLOT_ID)); }, []);

    const selecting = selectedIds !== null;
    /**
     * Resolved against the live list rather than trusted as ids: a chat deleted or
     * imported while a selection is open would otherwise stay in the count and in
     * whatever the actions then wrote.
     */
    const selectedSessions = selectedIds ? sessions.filter(s => selectedIds.includes(s.id)) : [];

    useEffect(() => {
        loadSessions();
        loadProjects();
    }, []);

    // Escape leaves selection mode. Guarded on the target because a rename input
    // handles Escape itself and the event still reaches the window — without this,
    // cancelling a rename would silently throw the selection away too.
    useEffect(() => {
        if (!selecting) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
            setSelectedIds(null);
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [selecting]);

    const toggleSelected = (sessionId: string) => {
        setSelectedIds(prev => {
            const picked = prev ?? [];
            return picked.includes(sessionId)
                ? picked.filter(id => id !== sessionId)
                : [...picked, sessionId];
        });
    };

    const loadSessions = async () => {
        try {
            const loadedSessions = await getSessions();
            setSessions(loadedSessions);
        } catch (error) {
            console.error('Error loading sessions:', error);
        }
    };

    const loadProjects = async () => {
        try {
            setProjects(await getProjects());
        } catch (error) {
            console.error('Error loading projects:', error);
        }
    };

    useEffect(() => {
        if (sessionsRefreshTrigger !== undefined) {
            loadSessions();
            loadProjects();
        }
    }, [sessionsRefreshTrigger]);

    // There is no `scarlettt:project-created` listener any more. Its only dispatcher
    // was the sidebar's "Folders" entry, and folders are now made from a selection —
    // `handleFolderFromSelection` below does the same four things directly, in the
    // component that owns the list, with no event round trip.

    // SideBarProject does the importing; this section owns the list, so it
    // reloads and opens what arrived.
    useEffect(() => {
        const handleImported = async (e: Event) => {
            await loadSessions();
            const id = (e as CustomEvent<string | undefined>).detail;
            if (id) onSessionSelect(id);
        };
        window.addEventListener("scarlettt:chat-imported", handleImported);
        return () => window.removeEventListener("scarlettt:chat-imported", handleImported);
    }, []);

    const handleRename = async (sessionId: string, title: string) => {
        // Paint the new title straight away; the reload just reconciles.
        setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, title } : s)));
        try {
            await renameSession(sessionId, title);
        } catch (error) {
            console.error('Error renaming session:', error);
        }
        loadSessions();
    };

    /** Reads each chat's messages so the format module can write them as one file. */
    const bundle = async (chats: ChatSession[]): Promise<ExportChat[]> =>
        Promise.all(chats.map(async s => ({ title: s.title, messages: await getMessages(s.id) })));

    /**
     * Writes Markdown to a path the user picks, reporting whether anything was
     * written — cancelling the dialog is not a share that happened, and callers
     * act on the difference. Filename can't hold path separators.
     */
    const writeMarkdown = async (name: string, markdown: string): Promise<boolean> => {
        const path = await save({
            defaultPath: `${name.replace(/[/\\:*?"<>|]/g, '-')}.md`,
            filters: [{ name: 'Markdown', extensions: ['md'] }],
        });
        if (!path) return false;
        await writeTextFile(path, markdown);
        return true;
    };

    /**
     * The one place a share is written — one chat, a folder, or a selection. They
     * differ only in what goes in and whether a folder name goes above it, so
     * `formatChatBundle` owns the shape and this owns the dialog.
     *
     * An empty bundle comes back as "": every chat handed over had no messages, so
     * there is no file to write. Saying so beats writing something that imports as
     * nothing.
     */
    const share = async (name: string, chats: ChatSession[], folder?: string): Promise<boolean> => {
        const markdown = formatChatBundle(await bundle(chats), folder);
        if (!markdown) {
            notify({
                id: SHARE_EMPTY_NOTICE,
                title: chats.length === 1
                    ? "That chat has no messages yet, so there's nothing to share."
                    : "Those chats have no messages yet, so there's nothing to share.",
                body: "A chat needs at least one message before it can be shared.",
            });
            return false;
        }
        return writeMarkdown(name, markdown);
    };

    const handleShare = async (session: ChatSession) => {
        try {
            await share(session.title, [session]);
        } catch (error) {
            console.error('Error sharing session:', error);
        }
    };

    // Sharing a folder bundles every chat in it into one document, under the
    // folder's own name — which is what brings it back as a folder on import.
    const handleShareProject = async (project: Project) => {
        try {
            await share(project.name, sessions.filter(s => s.project_id === project.id), project.name);
        } catch (error) {
            console.error('Error sharing project:', error);
        }
    };

    /**
     * A selection is written with no folder name above it, which is the only thing
     * separating it from a shared folder — so it imports as the separate chats it
     * was rather than being gathered into one.
     */
    const handleShareSelection = async () => {
        const chats = selectedSessions;
        if (chats.length === 0) return;
        try {
            const name = chats.length === 1 ? chats[0].title : `${chats.length} chats`;
            // Only cleared once something was actually written: a mistyped Escape
            // in the save dialog shouldn't cost the user every chat they picked.
            if (await share(name, chats)) setSelectedIds(null);
        } catch (error) {
            console.error('Error sharing selection:', error);
        }
    };

    /**
     * Turns the selection into a folder. The chats move rather than copy — they
     * keep their ids and their history — and the new folder opens straight into
     * its name field, the same as one created from the sidebar.
     */
    const handleFolderFromSelection = async () => {
        const chats = selectedSessions;
        if (chats.length === 0) return;
        try {
            const project = await createProject();
            // Sequential, like the import path: these share one SQLite connection
            // behind a mutex, so firing them together only queues them anyway.
            for (const chat of chats) await setSessionProject(chat.id, project.id);
            setSelectedIds(null);
            await loadProjects();
            await loadSessions();
            setExpandedProjectId(project.id);
            setRenamingProjectId(project.id);
        } catch (error) {
            console.error('Error creating folder from selection:', error);
        }
    };

    const handleNewChatInProject = async (projectId: string) => {
        try {
            const session = await createSession("New chat");
            await setSessionProject(session.id, projectId);
            setExpandedProjectId(projectId);
            await loadSessions();
            onSessionSelect(session.id);
        } catch (error) {
            console.error('Error creating chat in project:', error);
        }
    };

    const handleMoveToProject = async (sessionId: string, projectId: string | null) => {
        setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, project_id: projectId } : s)));
        if (projectId) setExpandedProjectId(projectId);
        try {
            await setSessionProject(sessionId, projectId);
        } catch (error) {
            console.error('Error moving chat to project:', error);
        }
        loadSessions();
    };

    const handleProjectRename = async (projectId: string, name: string) => {
        setProjects(prev => prev.map(p => (p.id === projectId ? { ...p, name } : p)));
        try {
            await renameProject(projectId, name);
        } catch (error) {
            console.error('Error renaming project:', error);
        }
        loadProjects();
    };

    const handleProjectDelete = async (project: Project) => {
        try {
            const shouldDelete = await ask(
                `Delete "${project.name}"? Its chats move back to Recent chats.`,
                { title: 'Delete Project', kind: 'warning' },
            );
            if (!shouldDelete) return;
            await deleteProject(project.id);
            loadProjects();
            loadSessions();
        } catch (error) {
            console.error('Error deleting project:', error);
        }
    };

    const handleDelete = async (sessionId: string) => {
        try {
            const shouldDelete = await ask("Are you sure you want to delete this chat?", {
                title: 'Delete Chat',
                kind: 'warning',
            });

            if (shouldDelete) {
                await deleteSession(sessionId);
                if (onSessionDelete) {
                    onSessionDelete(sessionId);
                }
                loadSessions();
            }
        } catch (error) {
            console.error('Error deleting session:', error);
        }
    };

    if (isCollapsed) return null;

    const pinnedSessions = sessions.filter(s => pinnedIds.includes(s.id));
    // Chats inside a project live under it, so they're not loose "recent" ones.
    const recentSessions = sessions.filter(s => !pinnedIds.includes(s.id) && !s.project_id);

    const step = loadStep(sessions.length);
    const visiblePinned = pinnedSessions.slice(0, pinnedLimit);
    const visibleRecent = recentSessions.slice(0, recentLimit);
    const allPinnedShown = pinnedLimit >= pinnedSessions.length;
    const allRecentShown = recentLimit >= recentSessions.length;

    const rowProps = (session: ChatSession) => ({
        isActive: activeSessionId === session.id,
        isPinned: isPinned(session.id),
        canPin: !isPinLimitReached,
        projects,
        selecting,
        selected: selectedIds?.includes(session.id) ?? false,
        onSelect: () => onSessionSelect(session.id),
        onBeginSelect: () => setSelectedIds([session.id]),
        onToggleSelect: () => toggleSelected(session.id),
        onTogglePin: () => togglePin(session.id),
        onRename: (title: string) => handleRename(session.id, title),
        onShare: () => handleShare(session),
        onMoveToProject: (projectId: string | null) => handleMoveToProject(session.id, projectId),
        onDelete: () => handleDelete(session.id),
    });

    return (
        <div className="flex flex-col w-full gap-8">
            {selecting && barSlot && createPortal(
                <SelectionBar
                    count={selectedSessions.length}
                    onShare={handleShareSelection}
                    onMakeFolder={handleFolderFromSelection}
                    onCancel={() => setSelectedIds(null)}
                />,
                barSlot,
            )}

            {pinnedSessions.length > 0 && (
                <div className="flex flex-col gap-2">
                    <p className={HEADING_CLASS}>Pinned chats</p>
                    <div className="flex flex-col">
                        {visiblePinned.map((session) => (
                            <SessionRow key={session.id} session={session} {...rowProps(session)} />
                        ))}
                    </div>
                    {pinnedSessions.length > PINNED_PREVIEW_COUNT && (
                        <button
                            className={`${TEXT_BUTTON_CLASS} px-2`}
                            onClick={() => setPinnedLimit(allPinnedShown ? PINNED_PREVIEW_COUNT : pinnedLimit + step)}
                        >
                            {allPinnedShown ? "View less" : "View all"}
                        </button>
                    )}
                </div>
            )}

            {projects.length > 0 && (
                <div className="flex flex-col gap-2">
                    <p className={HEADING_CLASS}>Folders</p>
                    <div className="flex flex-col">
                        {projects.map((project) => {
                            const projectChats = sessions.filter(s => s.project_id === project.id);
                            const isExpanded = expandedProjectId === project.id;
                            const limit = projectLimits[project.id] ?? PROJECT_PREVIEW_COUNT;
                            const allShown = limit >= projectChats.length;
                            return (
                                <div key={project.id} className="flex flex-col">
                                    <ProjectRow
                                        project={project}
                                        chatCount={projectChats.length}
                                        isExpanded={isExpanded}
                                        startRenaming={renamingProjectId === project.id}
                                        onRenameHandled={() => setRenamingProjectId(null)}
                                        onToggleExpand={() => setExpandedProjectId(isExpanded ? null : project.id)}
                                        onRename={(name) => handleProjectRename(project.id, name)}
                                        onShare={() => handleShareProject(project)}
                                        onDelete={() => handleProjectDelete(project)}
                                    />
                                    {isExpanded && (
                                        <div className="flex flex-col gap-2">
                                            {projectChats.length === 0 ? (
                                                <p className="pl-8 p-2 text-sm text-fg-faint">No chats yet</p>
                                            ) : (
                                                <div className="flex flex-col">
                                                    {projectChats.slice(0, limit).map((session) => (
                                                        <SessionRow key={session.id} session={session} indented {...rowProps(session)} />
                                                    ))}
                                                </div>
                                            )}
                                            {projectChats.length > PROJECT_PREVIEW_COUNT && (
                                                <button
                                                    className={`${TEXT_BUTTON_CLASS} pl-8`}
                                                    onClick={() => setProjectLimits(prev => ({
                                                        ...prev,
                                                        [project.id]: allShown ? PROJECT_PREVIEW_COUNT : limit + step,
                                                    }))}
                                                >
                                                    {allShown ? "View less" : "View all"}
                                                </button>
                                            )}
                                            <button
                                                className={`${TEXT_BUTTON_CLASS} pl-8 pb-2 flex items-center gap-1`}
                                                onClick={() => handleNewChatInProject(project.id)}
                                            >
                                                <Add size={12} color="rgb(var(--fg-secondary))" />
                                                New chat
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <p className={HEADING_CLASS}>Recent chats</p>
                    {/* Figma 155:387 — search sits on the Recent chats row. */}
                    <div className="cursor-pointer flex items-center justify-center w-4 h-4" onClick={onSearchClick}>
                        <SearchGlyph size={16} color="rgb(var(--fg-secondary))" />
                    </div>
                </div>
                <div className="flex flex-col">
                    {recentSessions.length === 0 ? (
                        <div className="p-2">
                            <p className="text-sm text-fg-faint">No chats yet</p>
                        </div>
                    ) : (
                        visibleRecent.map((session) => (
                            <SessionRow key={session.id} session={session} {...rowProps(session)} />
                        ))
                    )}
                </div>
                {recentSessions.length > RECENT_PREVIEW_COUNT && (
                    <button
                        className={`${TEXT_BUTTON_CLASS} px-2`}
                        onClick={() => setRecentLimit(allRecentShown ? RECENT_PREVIEW_COUNT : recentLimit + step)}
                    >
                        {allRecentShown ? "View less" : "View all"}
                    </button>
                )}
            </div>
        </div>
    );
}

export default SideBarChats;
