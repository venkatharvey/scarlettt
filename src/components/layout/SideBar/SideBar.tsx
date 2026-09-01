import SideBarHeader from "./SideBarHeader";
import SideBarProject from "./SideBarProject";
import SideBarChats, { SELECTION_BAR_SLOT_ID } from "./SideBarChats";
import Settings from "../../../svg/Settings";

interface SideBarProps {
    isCollapsed: boolean;
    activeSessionId?: string;
    onSessionSelect: (sessionId: string) => void;
    onNewChat: () => void;
    onOpenModels?: () => void;
    onOpenMcp?: () => void;
    onOpenSettings?: () => void;
    sessionsRefreshTrigger?: number;
    onSessionsChange?: () => void;
    onSessionDelete?: (sessionId: string) => void;
    onOpenSearch?: () => void;
}

export default function SideBar({
    isCollapsed,
    activeSessionId,
    onSessionSelect,
    onNewChat,
    onOpenModels,
    onOpenMcp,
    onOpenSettings,
    sessionsRefreshTrigger,
    onSessionDelete,
    onOpenSearch,
}: SideBarProps) {
    return (
        <>
            <div className="flex flex-col w-full h-full p-2 justify-between">
                {/* gap-8 (2rem), not gap-10. Header-to-nav is then the same 32px as
                    the nav-to-chats gap, so the whole sidebar sits on one rhythm. The
                    nav stays fixed; only the chat list scrolls. */}
                <div className="flex flex-col gap-8 w-full flex-1 min-h-0 overflow-hidden">
                    <SideBarHeader />

                    {/* Fixed nav — New chat, Models, MCP, Import stay put at the top
                        instead of scrolling away with the chat history below. */}
                    <div className="flex-shrink-0">
                        <SideBarProject
                            isCollapsed={isCollapsed}
                            onNewChat={onNewChat}
                            onOpenModels={onOpenModels}
                            onOpenMcp={onOpenMcp}
                        />
                    </div>

                    {/* flex-1 + min-h-0 so the chats scroll inside whatever space is
                        left between the fixed nav and Settings, instead of growing
                        past it. */}
                    <div className="flex flex-col gap-8 w-full flex-1 min-h-0 overflow-y-auto no-scrollbar" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
                        <SideBarChats
                            isCollapsed={isCollapsed}
                            activeSessionId={activeSessionId}
                            onSessionSelect={onSessionSelect}
                            onSearchClick={onOpenSearch}
                            sessionsRefreshTrigger={sessionsRefreshTrigger}
                            onSessionDelete={onSessionDelete}
                        />
                    </div>
                </div>

                {/* The panel's foot. Grouped into one child because the column is
                    `justify-between`: a third sibling would be pushed to the middle
                    rather than sitting down here. */}
                <div className="flex-shrink-0 flex flex-col">
                    {/* SideBarChats portals its selection actions in here — rendered
                        by the component that owns the selection, but positioned
                        outside the scrolling list so they stay put while picking. */}
                    <div id={SELECTION_BAR_SLOT_ID} />

                    {/* Same row treatment as the SideBarProject items. */}
                    {!isCollapsed && (
                        <div className="flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-hover transition-colors" onClick={onOpenSettings}>
                            <span className="flex-shrink-0 flex items-center justify-center w-4 h-4">
                                <Settings size={16} color="rgb(var(--fg))" />
                            </span>
                            <p className="text-sm leading-[18px] text-fg whitespace-nowrap">Settings</p>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
