interface StopProps {
    size: number;
    color: string;
}

// Material Symbols 24px "stop" glyph — a solid square, used to halt a reply
// that's still generating. Same family and viewBox as the other 960-unit icons.
// Filled rather than outlined: it sits at 16px inside a filled dark button, where
// the outlined version's 80-unit stroke read as a muddy ring rather than a square.
export default function Stop({ size, color }: StopProps) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 -960 960 960" fill={color}>
            <path d="M240-240v-480h480v480H240Z" />
        </svg>
    );
}
