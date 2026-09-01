interface ChevronDownProps {
    size: number;
    color: string;
    className?: string;
}

export default function ChevronDown({ size, color }: ChevronDownProps) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 20 20" fill="none">
<mask id="mask0_1_34" style={{maskType:"alpha"}} maskUnits="userSpaceOnUse" x="0" y="0" width={size} height={size}>
<rect width={size} height={size} fill="#D9D9D9"/>
</mask>
<g mask="url(#mask0_1_34)">
<path d="M9.5625 12.0625L6.54166 9.04168C6.5 9.00001 6.46875 8.95487 6.44791 8.90626C6.42708 8.85765 6.41666 8.80557 6.41666 8.75001C6.41666 8.6389 6.45486 8.54168 6.53125 8.45834C6.60764 8.37501 6.70833 8.33334 6.83333 8.33334H13.1667C13.2917 8.33334 13.3924 8.37501 13.4687 8.45834C13.5451 8.54168 13.5833 8.6389 13.5833 8.75001C13.5833 8.77779 13.5417 8.87501 13.4583 9.04168L10.4375 12.0625C10.3681 12.132 10.2986 12.1806 10.2292 12.2083C10.1597 12.2361 10.0833 12.25 10 12.25C9.91666 12.25 9.84028 12.2361 9.77083 12.2083C9.70139 12.1806 9.63194 12.132 9.5625 12.0625Z" fill={color}/>
</g>
</svg>
    );
}
