import { formatBytes } from "../../hooks/useSystemInfo";
import { DownloadState, describeDownload, downloadPercent } from "./useModelDownloads";
import { publisherFor } from "./modelFacts";

interface DownloadingRowProps {
    name: string;
    state: DownloadState;
    onCancel: () => void;
    /** Compact form for the detail page, where the name is already the heading. */
    compact?: boolean;
}

/**
 * An in-flight pull. Shown both at the top of the installed list and on the
 * model's own page, from the same state, so they can't disagree.
 */
export default function DownloadingRow({ name, state, onCancel, compact }: DownloadingRowProps) {
    const percent = downloadPercent(state);

    return (
        <div className="flex flex-col gap-1.5 p-2 rounded">
            {!compact && (
                <div className="flex items-center gap-2">
                    <span className="flex-1 min-w-0 text-sm leading-[18px] text-fg truncate">{name}</span>
                    <span className="flex-shrink-0 text-xs leading-4 text-fg-muted">{publisherFor(name)}</span>
                </div>
            )}

            {/* Indeterminate until Ollama starts reporting bytes — the manifest and
                verify phases send status only. */}
            <div className="h-1 w-full rounded-full bg-hover overflow-hidden">
                <div
                    className={`h-full bg-inverse rounded-full ${percent === null ? "animate-pulse w-1/3" : "transition-[width] duration-300"}`}
                    style={percent === null ? undefined : { width: `${percent}%` }}
                />
            </div>

            <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 text-xs leading-4 text-fg-muted truncate">
                    {describeDownload(state, formatBytes)}
                </span>
                <button
                    className="flex-shrink-0 px-2 py-0.5 rounded text-xs leading-4 text-bad-fg hover:bg-bad-bg transition-colors"
                    onClick={(e) => {
                        e.stopPropagation();
                        onCancel();
                    }}
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}
