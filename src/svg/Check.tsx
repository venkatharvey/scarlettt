interface CheckProps {
    size: number;
    color: string;
}

// Material Symbols 24px "check" glyph — same weight and viewBox as the other
// sidebar glyphs, so it matches them at any shared size.
export default function Check({ size, color }: CheckProps) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 -960 960 960" fill={color}>
            <path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z" />
        </svg>
    );
}
