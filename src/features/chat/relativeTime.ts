/** Shared by both message views so their action rows read identically. */
export function formatRelativeTime(iso?: string): string {
    if (!iso) return "";
    const then = new Date(iso).getTime();
    if (isNaN(then)) return "";
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    const units: [string, number][] = [
        ["year", 31536000],
        ["week", 604800],
        ["day", 86400],
        ["hour", 3600],
        ["minute", 60],
    ];
    for (const [name, secs] of units) {
        const value = Math.floor(seconds / secs);
        if (value >= 1) return `${value} ${name}${value === 1 ? "" : "s"} ago`;
    }
    return "just now";
}
