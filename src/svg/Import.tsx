interface ImportProps {
    size: number;
    color: string;
}

// Material Symbols 24px "download" glyph — an arrow dropping into an open tray,
// used for importing a shared chat. Same family and viewBox as Newsstand beside
// it, so the two line up at the same optical weight in the sidebar.
export default function Import({ size, color }: ImportProps) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 -960 960 960" fill={color}>
            <path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h200v80H160v480h640v-480H600v-80h200q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm320-184L280-544l56-56 104 104v-304h80v304l104-104 56 56-200 200Z" />
        </svg>
    );
}
