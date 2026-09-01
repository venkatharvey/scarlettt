interface AddProps {
    size: number;
    color: string;
}

// Material Symbols 24px "add" (plus) glyph — same weight and viewBox as the
// other sidebar glyphs, so it matches them at any shared size.
export default function Add({ size, color }: AddProps) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 -960 960 960" fill={color}>
            <path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z" />
        </svg>
    );
}
