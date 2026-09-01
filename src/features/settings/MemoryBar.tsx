import {
    SystemInfo, CeilingSource,
    formatBytes,
} from "../../hooks/useSystemInfo";

/** Which limit is deciding the context, in the user's terms rather than the code's. */
const SOURCE_LABEL: Record<CeilingSource, string> = {
    free: "free memory",
    gpu: "the GPU working set",
    ram: "the share of RAM this app will claim",
    reserve: "the memory you reserved for everything else",
};

const SOURCE_HINT: Record<CeilingSource, string> = {
    free: "Closing other apps is what raises the context — the reserve and GPU limits are already looser than this.",
    gpu: "Free memory is no longer the constraint: this model can't put more than this on the GPU, so freeing more RAM won't buy context.",
    ram: "This app caps itself at 70% of total RAM, and that cap is now the tightest limit.",
    reserve: "Lowering the reserve above would raise the context — it is currently the tightest limit.",
};

/**
 * One colour per band, fixed.
 *
 * The model's band used to carry the fit verdict — emerald / amber / red by
 * `Fit` — which meant it changed hue for a reason the bar itself never states,
 * and collided with the red already spent on reclaimed memory. The verdict is
 * said in words directly above the bar (the fit badge, and the "Too large"
 * paragraph), so the bar is free to answer only the question it is drawn to
 * answer: where the memory is going.
 */
// Data-viz bands: fixed, vivid Tailwind mid-tones, deliberately NOT tokenised. A
// 500-level colour reads clearly on both the light and the dark track, and the -fg
// status tokens are 600/700-level — too dark, and they visibly shifted the light
// "free" band from emerald-500 to emerald-700. The track behind them IS tokenised
// (bg-line-strong — a visible light grey, not the near-transparent bg-hover: when
// free memory is unknown only the model band renders and the rest of the track
// shows, so it has to read as a real, empty portion of total rather than blank pane).
const BAND = {
    inUse: "bg-zinc-400",
    reclaimed: "bg-red-500",
    free: "bg-emerald-500",
    model: "bg-blue-500",
};

interface MemoryBarProps {
    systemInfo: SystemInfo;
    /** Weights + cache at the context this model will actually run at. */
    required?: number;
    weights: number;
    /**
     * Bytes the model currently holds in memory, from `/api/ps`. Subtracted from
     * the in-use band so this app's own footprint isn't also counted as other
     * apps' — see `inUse`.
     */
    loadedBytes?: number;
    ceilingSource: CeilingSource;
}

/**
 * Where this machine's memory is going, and what it buys in context.
 *
 * Three figures were already on this page as prose — total, free, and what the
 * model needs — but the relationship between them was left to the reader, and it
 * is the relationship that explains the context length. Someone seeing "8k" on a
 * 16GB machine reasonably reads it as a bug; seeing that only 2.6GB of those 16
 * are actually available, and that the weights alone want 3.7GB, explains it in
 * one glance.
 *
 * The bar spans *total* RAM deliberately, even though only the free part is
 * spendable: a bar of free memory alone would show a model comfortably filling
 * "most of memory" while hiding that most of memory was never available.
 */
export default function MemoryBar({
    systemInfo, required, weights, loadedBytes, ceilingSource,
}: MemoryBarProps) {
    const total = systemInfo.total_memory;
    /**
     * Zero means *unknown*, not "none left".
     *
     * sysinfo computes available memory as free + inactive + purgeable −
     * compressor, with a saturating subtraction: under enough pressure the
     * compressor exceeds the other three and the whole figure floors at 0. Read as
     * a real measurement it produced a bar claiming the entire model had to be
     * reclaimed from other apps, alongside "— this model" and "the — available",
     * while the badge above it said "Runs well" — because `ceilingLimits` treats
     * the same 0 as unknown and skips the free-memory limit. Two code paths
     * disagreeing about one value; this side now agrees with the other.
     */
    const available = systemInfo.available_memory || undefined;

    /**
     * What everything *else* holds. The loaded model's own resident bytes are
     * subtracted because they are inside `total − available` already, and are drawn
     * again as this model's own band — counting them twice inflated "in use" by the
     * size of the model and made the app look like part of the problem it reports.
     */
    const inUse = available === undefined
        ? undefined
        : Math.max(total - available - (loadedBytes ?? 0), 0);

    /**
     * What the model already holds, and what it has yet to take out of free memory.
     *
     * Splitting the two is what keeps the bands adding up. `available` is what macOS
     * reports free *with the resident bytes already resident*, so those bytes were
     * never inside it and must not be carved out of it again — taking them off
     * `inUse` above and off `available` here is the same bytes twice. It read as a
     * bar whose segments summed to total minus one model, with that much bare track
     * on the right: 7.9GB in use + 109MB free + 4.0GB model on a 16GB machine, the
     * missing 4GB being the loaded model counted out of both sides. The prose said
     * it too — "109MB free" while 4.1GB really was free, the model having already
     * been paid for.
     */
    const held = loadedBytes ?? 0;
    const stillNeeded = Math.max((required ?? 0) - held, 0);
    const fromFree = available === undefined ? stillNeeded : Math.min(stillNeeded, available);
    const overflow = available === undefined ? 0 : Math.max(stillNeeded - available, 0);
    const stillFree = available === undefined ? 0 : Math.max(available - fromFree, 0);
    /** Everything this model accounts for: what it holds plus what it still takes. */
    const modelShown = held + fromFree;

    // The overflow is drawn *inside* the in-use region rather than after it, because
    // that is what actually happens: there is no spare room to extend into, so the
    // memory comes back out of what other processes hold, by compressing them. Drawn
    // any other way the segment either sums past 100% or renders at zero width in
    // exactly the case that most needs showing.
    const reclaimed = Math.min(overflow, inUse ?? 0);
    const inUseShown = Math.max((inUse ?? 0) - reclaimed, 0);

    const pct = (bytes: number) => `${(bytes / total) * 100}%`;


    return (
        <div className="flex flex-col gap-2">
            {/* Four distinct bands, each its own hue rather than steps of one
                neutral: spare memory used to be zinc-200 against a zinc-100 track,
                which is barely a band at all. Only what the system already holds
                stays grey — it is the part the user has no direct say over. */}
            <div className="flex h-2 w-full rounded-full overflow-hidden bg-line-strong">
                <div className={BAND.inUse} style={{ width: pct(inUseShown) }} title={`${formatBytes(inUseShown)} in use by the rest of the system`} />
                {reclaimed > 0 && (
                    <div
                        className={BAND.reclaimed}
                        style={{ width: pct(reclaimed) }}
                        title={`${formatBytes(overflow)} more than is free — macOS has to squeeze this much out of what other apps hold`}
                    />
                )}
                <div className={BAND.free} style={{ width: pct(stillFree) }} title={`${formatBytes(stillFree)} still free`} />
                {/* Last, so the band the reader came for ends at the bar's right edge
                    beside the total, rather than being buried between two others. */}
                <div className={BAND.model} style={{ width: pct(modelShown) }} title={`${formatBytes(modelShown)} for this model`} />
            </div>

            {/* The breakdown reads left-to-right under the bar it describes, and the
                total sits at the bar's right end — the end of the bar *is* the
                total, so anywhere else makes it look like one more component of
                the sum rather than the whole. `justify-between` spans exactly the
                bar's width, and the counts are tabular so a figure changing from
                "94MB" to "3.5GB" doesn't shuffle the row. */}
            <div className="flex items-start justify-between gap-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 min-w-0">
                    {/* Unknown free memory makes "in use" unknown too — it is
                        derived from it. `formatBytes(0)` renders an em dash, which
                        reads as a figure rather than as an absence. */}
                    {inUse !== undefined && <Key className={BAND.inUse} label={`${formatBytes(inUseShown)} in use`} />}
                    {reclaimed > 0 && <Key className={BAND.reclaimed} label={`${formatBytes(overflow)} reclaimed from apps`} />}
                    {/* `formatBytes` renders 0 as an em dash, which reads as a missing
                        value rather than "none left" — drop the key instead. */}
                    {available !== undefined && stillFree > 0 && <Key className={BAND.free} label={`${formatBytes(stillFree)} free`} />}
                    <Key className={BAND.model} label={`${formatBytes(modelShown)} this model`} />
                </div>
                <span className="flex-shrink-0 text-xs leading-4 text-fg-faint tabular-nums">
                    of {formatBytes(total)}
                </span>
            </div>

            {/* The single most useful sentence here: what to change to get more. */}
            <p className="text-xs leading-4 text-fg-secondary">
                The context is currently limited by <span className="text-fg">{SOURCE_LABEL[ceilingSource]}</span>.{" "}
                <span className="text-fg-muted">{SOURCE_HINT[ceilingSource]}</span>
            </p>

            {/* Only when free memory is actually known. Said against an unknown
                figure it read "larger than the — available", which asserts a
                comparison with nothing. */}
            {available !== undefined && weights > held + available && (
                <p className="text-xs leading-4 text-warn-fg">
                    The weights alone ({formatBytes(weights)}) are larger than the {formatBytes(available)} available, which is
                    why the context drops to its floor — macOS has to reclaim memory before this model can load at all.
                </p>
            )}

            {available === undefined && (
                <p className="text-xs leading-4 text-fg-muted">
                    macOS isn't reporting a free-memory figure right now — the compressor is holding more than the
                    reclaimable pages add up to. The context above is sized from this machine's RAM and GPU limits
                    instead.
                </p>
            )}

        </div>
    );
}

function Key({ className, label }: { className: string; label: string }) {
    return (
        <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full border border-line-strong ${className}`} />
            <span className="text-xs leading-4 text-fg-muted tabular-nums">{label}</span>
        </span>
    );
}
