import { HEADER_ROW_HEIGHT } from "../../../layout";

// Spacer for the row the native macOS traffic lights occupy (they're positioned
// there via trafficLightPosition in tauri.conf.json, so there's no element for
// them). The collapse toggle is NOT rendered here — it lives in App as a fixed
// overlay so it stays put while the card animates. Draggable, since this row
// stands in for the window's title bar.
export default function SideBarHeader() {
    return (
        <div
            className="flex-shrink-0 w-full"
            style={{ height: HEADER_ROW_HEIGHT }}
            data-tauri-drag-region
        />
    );
}
