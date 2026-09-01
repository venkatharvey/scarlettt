// Shared shell geometry. The native macOS traffic lights are positioned by
// tauri.conf.json (trafficLightPosition), and several bits of UI have to line up
// with them, so the numbers live here rather than being repeated per component.

/**
 * macOS shows the native traffic lights (positioned by trafficLightPosition);
 * Windows and Linux don't — `titleBarStyle: "Overlay"` is ignored there and the
 * window uses native decorations instead. So the toggle lines up with the lights on
 * macOS and sits at the card's left edge everywhere else, rather than leaving a gap
 * for lights that aren't there. Read from the webview at load — on macOS
 * `navigator.platform` is "MacIntel".
 */
export const IS_MAC =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent || "");

/** Breathing room around the whole app shell. */
export const APP_INSET = 8;

/** The sidebar card's own padding (`p-2`). */
export const SIDEBAR_CARD_PADDING = 8;

/** The sidebar header row's vertical padding (`py-1`). */
export const HEADER_ROW_PADDING_Y = 4;

/** Collapse/expand control: 24px hit+hover box around a 16px glyph. */
export const COLLAPSE_BUTTON_SIZE = 24;

/**
 * Vertical centre of the sidebar header row's tallest item (the collapse
 * button): card top + card padding + row padding + half the button.
 * The traffic lights are centred on this same axis.
 */
export const HEADER_ROW_CENTER_Y =
    APP_INSET + SIDEBAR_CARD_PADDING + HEADER_ROW_PADDING_Y + COLLAPSE_BUTTON_SIZE / 2;

/** Traffic-light cluster: three 12px buttons, centres 20px apart. */
export const TRAFFIC_LIGHT_SIZE = 12;
export const TRAFFIC_LIGHT_SPACING = 20;
/** Matches trafficLightPosition.x — card padding + the logo's old `px-2`. */
export const TRAFFIC_LIGHTS_X = APP_INSET + SIDEBAR_CARD_PADDING + 8;
export const TRAFFIC_LIGHTS_END_X =
    TRAFFIC_LIGHTS_X + TRAFFIC_LIGHT_SPACING * 2 + TRAFFIC_LIGHT_SIZE;

/**
 * The collapse/expand control is grouped with the traffic lights: it sits this
 * far right of them, in BOTH the expanded and collapsed states, so the cluster
 * reads as one unit and the control never appears to move.
 */
export const COLLAPSE_BUTTON_GAP = 16;
// macOS: grouped just right of the traffic lights. Elsewhere there are none, so the
// toggle sits at the card's content-box left edge (card inset + padding) instead.
export const COLLAPSE_BUTTON_X = IS_MAC
    ? TRAFFIC_LIGHTS_END_X + COLLAPSE_BUTTON_GAP
    : APP_INSET + SIDEBAR_CARD_PADDING;

/**
 * Left padding for the sidebar header row so its collapse button lands on
 * COLLAPSE_BUTTON_X. The row's content box starts at APP_INSET + card padding.
 */
export const HEADER_LEFT_INSET =
    COLLAPSE_BUTTON_X - (APP_INSET + SIDEBAR_CARD_PADDING);

/** Top of the toggle, so it centres on the traffic lights' axis. */
export const COLLAPSE_BUTTON_Y = HEADER_ROW_CENTER_Y - COLLAPSE_BUTTON_SIZE / 2;

/**
 * Height the sidebar header row reserves. The toggle itself is rendered outside
 * the card (fixed, so it never moves when the card animates), so this row is
 * just the space the traffic lights need plus the drag region.
 */
export const HEADER_ROW_HEIGHT = COLLAPSE_BUTTON_SIZE + HEADER_ROW_PADDING_Y * 2;

export const SIDEBAR_EXPANDED_RADIUS = 16;

/**
 * The matching tauri.conf.json value is:
 *   trafficLightPosition: { x: TRAFFIC_LIGHTS_X, y: TRAFFIC_LIGHTS_CONF_Y }
 * (+8 because tao sizes the title-bar container to `buttonHeight + y` and keeps
 * the buttons ~8px off its bottom, so the visible top edge lands near `y - 8`.)
 * Keep the config in sync if APP_INSET or COLLAPSE_BUTTON_SIZE changes.
 */
export const TRAFFIC_LIGHTS_CONF_Y =
    HEADER_ROW_CENTER_Y - TRAFFIC_LIGHT_SIZE / 2 + 8;

/**
 * The fill the onboarding screen paints. Onboarding only — the app's own panes are
 * unchanged (`#f5f5f5` for the main pane, `#fafafa` for the sidebar card).
 *
 * It briefly drove the chat pane too, on the reading that finishing onboarding should
 * look like one surface staying put. That was wrong: it changed the app itself, which
 * was not what was asked for, and it flattened the `#fafafa` composer card and the
 * white cards in the library against a white pane. Keep this to the onboarding screen.
 */
export const ONBOARDING_SURFACE = "rgb(var(--surface-card))";
