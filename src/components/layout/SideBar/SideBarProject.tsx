import Add from "../../../svg/Add";
import Newsstand from "../../../svg/Newsstand";
import Braces from "../../../svg/Braces";
import Import from "../../../svg/Import";
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { useProjects } from "../../../hooks/useProjects";
import { useChatStorage } from "../../../hooks/useChatStorage";
import { parseChatFile } from "../../../features/chat/transcript";

interface SideBarProjectProps {
    isCollapsed: boolean;
    onNewChat?: () => void;
    onOpenModels?: () => void;
    onOpenMcp?: () => void;
}

export default function SideBarProject({ isCollapsed, onNewChat, onOpenModels, onOpenMcp }: SideBarProjectProps) {
    const iconSize = 16;
    const { createProject, setSessionProject } = useProjects();
    const { importChat } = useChatStorage();

    // Creating is fire-and-announce: SideBarChats owns the Projects section, so
    // it listens for this and opens the new row straight into its name field.
    /**
     * Loads a chat someone else shared. The file is whatever Share produced, so
     * `parseChatFile` reads exactly the format `handleShare` writes.
     *
     * A project export holds several conversations, so this imports every chat it
     * finds rather than only the first — silently dropping the rest would look
     * like a broken import.
     */
    const handleImportChat = async () => {
        try {
            const selected = await open({
                multiple: false,
                filters: [{ name: 'Shared chat', extensions: ['md', 'markdown', 'txt'] }],
            });
            if (!selected) return;

            const path = Array.isArray(selected) ? selected[0] : selected;
            const { folder, chats } = parseChatFile(await readTextFile(path));
            if (!chats.length) {
                console.warn('No conversation found in', path);
                window.dispatchEvent(new CustomEvent("scarlettt:chat-import-failed"));
                return;
            }

            // A shared folder comes back as a folder. Without this its chats would
            // scatter into Recent chats and the grouping the sender organised would
            // be lost in transit.
            const folderId = folder ? (await createProject(folder)).id : undefined;

            let lastId: string | undefined;
            for (const chat of chats) {
                const session = await importChat(chat.title, chat.messages);
                if (folderId) await setSessionProject(session.id, folderId);
                lastId = session.id;
            }
            // SideBarChats owns the list, so it reloads and opens what arrived —
            // same fire-and-announce shape as creating a project.
            window.dispatchEvent(new CustomEvent("scarlettt:chat-imported", { detail: lastId }));
        } catch (error) {
            console.error('Error importing chat:', error);
            window.dispatchEvent(new CustomEvent("scarlettt:chat-import-failed"));
        }
    };

    // No "Folders" entry. It made an empty folder with a blank starter chat in it,
    // which is a folder before there is anything to file — and it sat in the nav
    // permanently for something most people do once. Folders are made from the chats
    // that go in them instead: select two or more in the list and press "New folder",
    // which files them, expands the folder and puts its name straight into edit mode
    // (`handleFolderFromSelection`). The Folders *section* below the list is
    // unchanged and appears as soon as one exists.
    const items = [
        { icon: <Add size={iconSize} color="rgb(var(--fg))" />, label: "New chat", onClick: onNewChat },
        { icon: <Newsstand size={iconSize} color="rgb(var(--fg))" />, label: "Models library", onClick: onOpenModels },
        { icon: <Braces size={iconSize} color="rgb(var(--fg))" />, label: "MCP servers", onClick: onOpenMcp },
        { icon: <Import size={iconSize} color="rgb(var(--fg))" />, label: "Import chat", onClick: handleImportChat },
    ];

    return (
        <div className="flex flex-col w-full">
            {items.map((item) => (
                <div
                    key={item.label}
                    className={`flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-hover transition-colors ${isCollapsed ? "justify-center" : ""}`}
                    onClick={item.onClick}
                >
                    <span className="flex-shrink-0 flex items-center justify-center w-4 h-4">{item.icon}</span>
                    <span className={`overflow-hidden transition-all duration-500 ease-in-out ${isCollapsed ? "max-w-0 opacity-0" : "max-w-[200px] opacity-100"}`}>
                        <p className="text-sm leading-[18px] text-fg whitespace-nowrap">{item.label}</p>
                    </span>
                </div>
            ))}
        </div>
    );
}
