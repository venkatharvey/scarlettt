import { useEffect, useRef, useState } from "react";

/**
 * Copies text and reports it for a moment, so a click that changes nothing on
 * screen still confirms itself.
 *
 * The confirmation is a rendered bubble rather than only a `title` swap: browsers
 * don't re-read the `title` attribute while a tooltip is already showing, so a
 * button clicked with the cursor resting on it — which is every copy click —
 * would keep saying "Copy". The `title` is updated too, for the case where the
 * pointer leaves and returns.
 */
export function useCopied(ms = 1600) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<number | undefined>(undefined);

    useEffect(() => () => window.clearTimeout(timer.current), []);

    const copy = async (text: string) => {
        // Confirm only what actually happened. `writeText` rejects rather than
        // throwing — a denied permission, or a window that isn't focused — so
        // firing the confirmation alongside the call claimed success on every
        // failure. Observed live: the clipboard refused with NotAllowedError while
        // the button still reported "Copied".
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            return;
        }
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), ms);
    };

    return { copied, copy };
}

/**
 * The confirmation itself. Sits below the trigger, which must be `relative`.
 *
 * `pointer-events-none` is what makes below safe: the action row it belongs to is
 * revealed on hover, and a bubble that could take the pointer would let the row
 * hide itself the moment the tooltip appeared under the cursor.
 */
export function CopiedBubble({ show, label = "Copied" }: { show: boolean; label?: string }) {
    if (!show) return null;
    return (
        <span className="absolute top-full left-1/2 -translate-x-1/2 mt-1 px-1.5 py-0.5 rounded bg-inverse text-inverse-fg text-xs leading-4 whitespace-nowrap pointer-events-none z-10">
            {label}
        </span>
    );
}
