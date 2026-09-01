// A wrench, for MCP tool-call cards. Follows the src/svg convention: inline path,
// size/color props, no external asset.
export default function ToolGlyph({ size = 14, color = "#0A0A0A" }: { size?: number; color?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 14 14" fill="none">
            <path
                d="M9.98 1.4a3.15 3.15 0 0 0-3.02 4.06L1.9 10.52a1.2 1.2 0 0 0 1.7 1.7l5.06-5.06A3.15 3.15 0 0 0 12.6 4a.44.44 0 0 0-.74-.2l-1.2 1.2-1.06-.28-.28-1.06 1.2-1.2a.44.44 0 0 0-.2-.74A3.2 3.2 0 0 0 9.98 1.4Z"
                stroke={color}
                strokeWidth="0.9"
                strokeLinejoin="round"
                fill="none"
            />
        </svg>
    );
}
