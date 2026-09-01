import "./css/index.css";
import ChatPage from "./features/chat/ChatPage";
import ModelsLibrary from "./features/models/ModelsLibrary";
import NoticeHost from "./features/notices/NoticeHost";
import { NoticeAction, notify, dismiss, PREVIOUS_DATA_ARCHIVED_NOTICE } from "./features/notices/notices";
import SearchPage from "./features/search/SearchPage";
import SettingsPage from "./features/settings/SettingsPage";
import McpServersPage from "./features/mcp/McpServersPage";
import SideBar from "./components/layout/SideBar/SideBar";
import Onboarding, { OnboardingResult } from "./features/firstRun/Onboarding";
import DockToRight from "./svg/DockToRight";
import { useState, useEffect } from "react";
import { useChatStorage } from "./hooks/useChatStorage";
import { useOllama, canChat } from "./hooks/useOllama";
import { useSettings } from "./hooks/useSettings";
import { useTheme } from "./hooks/useTheme";
import { invoke } from "@tauri-apps/api/core";

import {
    APP_INSET,
    COLLAPSE_BUTTON_SIZE,
    COLLAPSE_BUTTON_X,
    COLLAPSE_BUTTON_Y,
    HEADER_ROW_HEIGHT,
    SIDEBAR_EXPANDED_RADIUS,
} from "./layout";

/**
 * The sidebar's one width (Figma 155:344). It used to be draggable between 200 and
 * 400 and persisted per machine, which is gone: a chat list needs one good width, not
 * a preference, and the drag handle sat on the same edge the collapse toggle already
 * controls. Collapsing still animates this to 0.
 */
const SIDEBAR_WIDTH = 264;

// Collapse/expand: the card's width animates to 0 — leaving just the fixed
// toggle icon, with no card behind it — while its contents cross-fade. One
// duration and one easing curve for everything that moves, so the sidebar, the
// chat column (which reflows off the card's width) and the fade all travel
// together instead of arriving at different times.
const SIDEBAR_SLIDE_MS = 300;
const SIDEBAR_FADE_MS = 150;
// Standard "ease-out"-ish curve: quick to start, settles gently.
const SIDEBAR_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

/**
 * How long after the chat has painted before the "previous chats were set aside"
 * toast slides in. Long enough that the two are read as one thing following another
 * rather than two things happening together.
 */
const TOAST_AFTER_CHAT_MS = 400;

/** The archived-data toast, in one place so the real path and the dev key agree. */
const archivedToast = () => ({
    id: PREVIOUS_DATA_ARCHIVED_NOTICE,
    title: "Your previous chats were set aside.",
    body: "Restore or delete them any time in Settings.",
    placement: "toast" as const,
});

function App() {
    /**
     * Gates the whole app until onboarding is settled — the restore-or-fresh
     * question, the engine, and a model that can chat. Starts `true` so a reinstall
     * can never briefly show the previous chats before asking: the screen renders
     * instead of the shell, not over it. `Onboarding` clears it immediately on an
     * ordinary launch, which is every launch but the first of an installation.
     */
    const [onboarding, setOnboarding] = useState(true);
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
    // The main pane shows either the conversation or the models library.
    const [view, setView] = useState<"chat" | "models" | "settings" | "search" | "mcp">("chat");
    /**
     * Where the models library should open, when it was reached from a notice
     * rather than the sidebar. Cleared on every other route into the library, so
     * browsing later isn't still pinned to a model from an old notice.
     */
    const [modelsTarget, setModelsTarget] = useState<{ model?: string; query?: string }>();
    const openModels = (target?: { model?: string; query?: string }) => {
        setModelsTarget(target);
        setView("models");
    };
    const handleNoticeAction = (action: NoticeAction) =>
        openModels(action.kind === "install" ? { model: action.model } : { query: action.query });
    const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
    const { getSessions } = useChatStorage();
    const { listModels } = useOllama();
    const { settings } = useSettings();
    // Keep <html data-theme> in step with the preference (and the OS, under `auto`).
    useTheme(settings.theme);

    /**
     * ⌥⇧T raises the archived-data toast, for looking at it without walking the whole
     * fresh-start flow to get there.
     *
     * Development only — `import.meta.env.DEV` is false in any production build, the
     * same gate that kept the `local` badge out of a release. Two details that would
     * otherwise make the key look broken: `notify` ignores a re-raise it considers
     * identical, so the current one has to be dismissed first; and NoticeHost holds a
     * *leaving* id for the length of the exit animation, so re-raising inside that
     * window would render the new toast already sliding out.
     */
    useEffect(() => {
        if (!import.meta.env.DEV) return;
        const onKey = (event: KeyboardEvent) => {
            if (!event.altKey || !event.shiftKey || event.code !== "KeyT") return;
            event.preventDefault();
            dismiss(PREVIOUS_DATA_ARCHIVED_NOTICE);
            window.setTimeout(() => notify(archivedToast()), 300);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    // Push offline mode into Rust, where it's actually enforced. Runs on mount
    // too, so a setting persisted from a previous session takes effect before
    // anything has a chance to reach the network.
    useEffect(() => {
        invoke('set_offline_mode', { enabled: settings.offlineMode })
            .catch(error => console.error('Failed to apply offline mode:', error));
    }, [settings.offlineMode]);

    // Same shape as offline mode: the persisted setting is the source of truth, pushed
    // into Rust on mount (and on change) — enabling is what pulls the embedding model
    // and backfills the index, so nothing about semantic search happens until this runs.
    useEffect(() => {
        invoke('set_semantic_search', { enabled: settings.semanticSearch })
            .catch(error => console.error('Failed to apply semantic search setting:', error));
    }, [settings.semanticSearch]);
    const [selectedModel, setSelectedModel] = useState("Dolphin 3.0");

    const [sessionsRefreshTrigger, setSessionsRefreshTrigger] = useState(0);

    const initializeModel = async () => {
        const savedModel = localStorage.getItem('selected_model');
        if (savedModel) {
            setSelectedModel(savedModel);
        } else {
            try {
                // Only a model that can actually answer. Defaulting into an
                // embedding model would open the app on a chat that cannot work.
                const models = (await listModels()).filter(canChat);
                if (models.length > 0) {
                    const defaultModel = models[0].name;
                    setSelectedModel(defaultModel);
                    localStorage.setItem('selected_model', defaultModel);
                }
            } catch (error) {
                console.error('Failed to auto-detect models:', error);
            }
        }
    };

    // Load persisted model or detect available models
    useEffect(() => {
        initializeModel();
    }, []);

    const handleModelSelect = (model: string) => {
        setSelectedModel(model);
        localStorage.setItem('selected_model', model);
    };

    // Load most recent session on mount (if any exist)
    useEffect(() => {
        loadMostRecentSession();
    }, []);

    const loadMostRecentSession = async () => {
        try {
            const sessions = await getSessions();
            if (sessions.length > 0) {
                // Load most recent session
                setActiveSessionId(sessions[0].id);
            }
            // If no sessions exist, activeSessionId stays undefined
            // User can click "New Chat" to create first session
        } catch (error) {
            console.error('Error loading sessions:', error);
        }
    };

    const handleNewChat = () => {
        setActiveSessionId(undefined);
        setView("chat");
    };

    const handleSessionCreate = (newSessionId: string) => {
        setActiveSessionId(newSessionId);
        handleSessionChange();
    };

    // Anything that opens a conversation also leaves the library.
    const handleSessionSelect = (sessionId: string) => {
        setActiveSessionId(sessionId);
        setView("chat");
    };

    const handleSessionChange = () => {
        // Trigger sessions reload in SideBarChats via sessionsRefreshTrigger
        setSessionsRefreshTrigger(prev => prev + 1);
    };

    const handleSessionDelete = (sessionId: string) => {
        if (activeSessionId === sessionId) {
            setActiveSessionId(undefined);
        }
    };

    const toggleSidebar = () => setIsSidebarCollapsed(v => !v);

    // Both width AND margin-left change between states, so both have to be in the
    // transition — otherwise the margin snaps and the whole thing looks like it
    // stutters. The fade overlaps the slide (rather than running before/after it)
    // so collapsing reads as one continuous motion.
    const bgTransition =
        `width ${SIDEBAR_SLIDE_MS}ms ${SIDEBAR_EASE}, margin-left ${SIDEBAR_SLIDE_MS}ms ${SIDEBAR_EASE}`;

    // Collapsing: contents fade out over the first half of the slide.
    // Expanding: they fade in over the second half, once there's room for them.
    const contentTransition = isSidebarCollapsed
        ? `opacity ${SIDEBAR_FADE_MS}ms ${SIDEBAR_EASE} 0ms`
        : `opacity ${SIDEBAR_FADE_MS}ms ${SIDEBAR_EASE} ${SIDEBAR_SLIDE_MS - SIDEBAR_FADE_MS}ms`;

    /**
     * Onboarding hands over what it did, because the app can't infer it. A model it
     * just installed is the one to open on — `selected_model` may name a model that
     * a fresh start left behind — and a fresh start empties the sessions the mount
     * effects above already read, so the sidebar and the open conversation both
     * have to be reset rather than left pointing at rows that are gone.
     */
    const finishOnboarding = async ({ installed, startNewChat, archivedPath }: OnboardingResult) => {
        // Awaited, and that matters: `setOnboarding(false)` below mounts ChatPage,
        // which raises its "isn't installed" notice from its first render — and until
        // this resolves, `selectedModel` is still the hardcoded default above, a name
        // that on a first install was never on the machine. Unawaited, the shell
        // renders first and that notice lands about a model the user never chose.
        if (installed) handleModelSelect(installed);
        else await initializeModel();
        if (startNewChat) {
            setActiveSessionId(undefined);
            setView("chat");
            handleSessionChange();
        }
        setOnboarding(false);

        // Raised *after* the chat is on screen, not before.
        //
        // Two reasons it waits. It is raised here rather than inside onboarding so it
        // does not sit behind a download that can take minutes — the notice store
        // outlives the component and would happily keep it, but the user would then
        // meet a stale toast on arrival. And it waits for a paint because the line
        // above only *schedules* the shell: raising it in the same tick had the toast
        // sliding in while the chat was still appearing, so two things moved at once
        // and neither got looked at.
        //
        // Two frames, then a beat: the first frame commits the shell, the second is
        // after the browser has actually painted it, and the delay lets it settle so
        // the toast reads as arriving afterwards rather than with it.
        if (archivedPath) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                window.setTimeout(() => notify(archivedToast()), TOAST_AFTER_CHAT_MS);
            }));
        }
    };

    if (onboarding) {
        return <Onboarding onDone={finishOnboarding} />;
    }

    return (
        // titleBarStyle "Overlay" hides the native bar, so the window needs its own
        // drag region. Tauri matches the EXACT event target, so only this element's
        // bare background drags — child buttons, text and inputs are unaffected.
        <div
            className="flex items-center justify-center min-h-screen w-full bg-surface"
            data-tauri-drag-region
        >
            {/* Collapse/expand toggle — fixed, and OUTSIDE the card, so it stays
                in exactly the same spot in both states instead of riding along as
                the card animates. Grouped with the traffic lights. */}
            <button
                onClick={toggleSidebar}
                title={isSidebarCollapsed ? "Open sidebar" : "Collapse sidebar"}
                style={{
                    left: COLLAPSE_BUTTON_X,
                    top: COLLAPSE_BUTTON_Y,
                    width: COLLAPSE_BUTTON_SIZE,
                    height: COLLAPSE_BUTTON_SIZE,
                }}
                className="fixed z-50 flex items-center justify-center rounded hover:bg-hover/70 transition-colors"
            >
                <DockToRight size={16} color="rgb(var(--fg))" />
            </button>

            {/* The #fafafa card (Figma 155:344 — 264px, p-2, rounded-16). Collapsing
                animates its width to 0, so nothing is left behind the toggle. */}
            <div
                className="relative self-start flex-shrink-0 bg-raised overflow-hidden"
                style={{
                    width: isSidebarCollapsed ? 0 : SIDEBAR_WIDTH,
                    height: `calc(100vh - ${APP_INSET * 2}px)`,
                    borderRadius: SIDEBAR_EXPANDED_RADIUS,
                    marginTop: APP_INSET,
                    marginBottom: APP_INSET,
                    marginLeft: isSidebarCollapsed ? 0 : APP_INSET,
                    // Width/margin animate every frame — hint it so the browser
                    // doesn't re-do layout work it could have prepared for.
                    willChange: "width, margin-left",
                    transition: bgTransition,
                }}
            >
                {/* Fading contents — only these fade in/out on collapse/expand. */}
                <div
                    className="absolute top-0 left-0 z-10"
                    style={{
                        width: SIDEBAR_WIDTH,
                        height: `calc(100vh - ${APP_INSET * 2}px)`,
                        opacity: isSidebarCollapsed ? 0 : 1,
                        transition: contentTransition,
                        pointerEvents: isSidebarCollapsed ? "none" : "auto",
                    }}
                >
                    <SideBar
                        isCollapsed={false}
                        activeSessionId={activeSessionId}
                        onSessionSelect={handleSessionSelect}
                        onNewChat={handleNewChat}
                        onOpenModels={() => openModels()}
                        onOpenMcp={() => setView("mcp")}
                        onOpenSettings={() => setView("settings")}
                        onOpenSearch={() => setView("search")}
                        sessionsRefreshTrigger={sessionsRefreshTrigger}
                        onSessionsChange={handleSessionChange}
                        onSessionDelete={handleSessionDelete}
                    />
                </div>
            </div>
            <div className="flex-1 h-screen flex flex-col min-w-0">
                {/* Full-width title-bar row. The window has no native bar, so this
                    empty strip is what makes the *whole* top draggable — not just the
                    sidebar header — and it drops the main content to the same line the
                    sidebar list starts on. Tauri matches the exact event target, so
                    the notice buttons and chat rendered below it stay clickable and
                    selectable; only this bare strip drags the window. */}
                <div
                    className="flex-shrink-0 w-full"
                    style={{ height: HEADER_ROW_HEIGHT }}
                    data-tauri-drag-region
                />
                <NoticeHost onAction={handleNoticeAction} />
                {/* Fills the height left after the title-bar strip and any notice
                    banner, so each view sizes to the *remaining* space rather than a
                    full 100vh — without this, ChatPage's `h-full` (100vh) plus the
                    32px strip ran the app past the bottom of the viewport. `min-h-0`
                    lets the scrolling views shrink so their own overflow works. */}
                <div className="flex-1 min-h-0 flex flex-col">
                {view === "settings" ? (
                    <SettingsPage currentModel={selectedModel} />
                ) : view === "mcp" ? (
                    <McpServersPage />
                ) : view === "search" ? (
                    <SearchPage
                        sessionsRefreshTrigger={sessionsRefreshTrigger}
                        onSessionSelect={(id) => { handleSessionSelect(id); setView("chat"); }}
                    />
                ) : view === "models" ? (
                    <ModelsLibrary
                        // Remounts on target change, which is what carries the
                        // notice's model into its initial state.
                        key={modelsTarget?.model ?? modelsTarget?.query ?? "browse"}
                        currentModel={selectedModel}
                        onModelSelect={handleModelSelect}
                        initialModel={modelsTarget?.model}
                        initialQuery={modelsTarget?.query}
                    />
                ) : (
                    <ChatPage
                        model={selectedModel}
                        onModelSelect={handleModelSelect}
                        onBrowseModels={() => openModels()}
                        sessionId={activeSessionId}
                        onSessionChange={handleSessionChange}
                        onSessionCreate={handleSessionCreate}
                    />
                )}
                </div>
            </div>
        </div>
    );
}

export default App;
