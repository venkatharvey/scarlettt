// The home-screen hero line. One greeting is drawn per app launch and held for
// the whole run, so starting a second chat doesn't reshuffle it mid-session.

/**
 * `{name}` goes wherever the sentence wants it — leading, mid, or trailing — and
 * `renderGreeting` sorts out the punctuation when there's no name to insert. Two
 * rules only: use it exactly once per line, and put a comma (not a dash) after a
 * leading name, so removing it doesn't strand the dash.
 *
 * Keep them short. The hero is 24px in a 640px column — about 56 characters —
 * and every line below fits on one, so the composer sits at the same height on
 * every launch. That budget now absorbs long names too: the longest greeting is
 * 45 characters with a four-letter name, leaving room for a much longer one.
 */
const POOLS = {
    morning: [
        "Hey {name}, what's the plan today?",
        "Good morning, {name}. Sleep well?",
        "Morning, {name}! Where should we start?",
        "Hey {name}, how's the day looking?",
        "Rise and shine, {name}.",
        "Fresh start, {name}. What are we making?",
        "Hey {name}, ready when you are.",
        "Morning, {name}. Ask me anything.",
        "{name}, what's first on the list?",
        "{name}, let's make today count.",
    ],
    afternoon: [
        "Hey {name}, what are you working on?",
        "Afternoon, {name}! What's on your mind?",
        "Hey {name}, how's it going so far?",
        "What's next, {name}?",
        "Hey {name}, need a hand with something?",
        "Good afternoon, {name}. Where were we?",
        "Hey {name}, what's cooking?",
        "Back for more, {name}? Let's go.",
        "{name}, what can I help with?",
        "{name}, pick up where we left off?",
    ],
    evening: [
        "Hey {name}, how was your day?",
        "Evening, {name}! What's on your mind?",
        "Hey {name}, wrapping up or just starting?",
        "Good evening, {name}. What's left to do?",
        "Hey {name}, one more idea before you go?",
        "Winding down, {name}?",
        "Evening, {name}. Let's get into it.",
        "Hey {name}, what's the plan tonight?",
        "{name}, how'd it go today?",
        "{name}, got a minute for one more?",
    ],
    night: [
        "Still up, {name}?",
        "Hey {name}, late night?",
        "Burning the midnight oil, {name}?",
        "Can't sleep, {name}? Let's talk.",
        "Hey {name}, what's keeping you up?",
        "Night owl mode, {name}.",
        "Quiet hours, {name}. What's on your mind?",
        "Hey {name}, still going?",
        "{name}, what are we solving tonight?",
        "{name}, the quiet hours are the best ones.",
    ],
} as const;

/** Session-scoped, so a reload during dev doesn't count as a fresh launch. */
const SESSION_KEY = "scarlettt_session_greeting";

function poolForHour(hour: number): readonly string[] {
    if (hour >= 6 && hour < 12) return POOLS.morning;
    if (hour >= 12 && hour < 17) return POOLS.afternoon;
    if (hour >= 17 && hour < 23) return POOLS.evening;
    return POOLS.night;
}

/**
 * The template for this run of the app. `sessionStorage` is the whole mechanism:
 * the webview is torn down on quit so the next launch draws again, while an
 * in-session reload (or a second chat, which only re-renders) keeps the line
 * that's already on screen.
 *
 * Returns the template rather than finished text because the name arrives from
 * the backend a beat later — see `useUserName`.
 */
export function sessionGreetingTemplate(): string {
    try {
        const held = sessionStorage.getItem(SESSION_KEY);
        if (held) return held;
    } catch {
        // Storage disabled — a fresh pick per render is still better than nothing.
    }

    const pool = poolForHour(new Date().getHours());
    const picked = pool[Math.floor(Math.random() * pool.length)];

    try {
        sessionStorage.setItem(SESSION_KEY, picked);
    } catch {
        // Ignored for the same reason.
    }
    return picked;
}

/**
 * Fills in `{name}`, or removes it cleanly when the OS wouldn't give one.
 *
 * Which punctuation goes with the name depends on where it sits, so the three
 * positions are handled separately — a single rule always mangles one of them:
 *
 *   "{name}, what's the plan?"     → "What's the plan?"      (comma follows)
 *   "Hey {name}, how was your day?"→ "Hey, how was your day?" (comma stays put)
 *   "Still up, {name}?"            → "Still up?"             (comma precedes)
 *
 * Only the first match is replaced, so a template must use `{name}` just once.
 */
export function renderGreeting(template: string, name?: string): string {
    if (name) return template.replace("{name}", name);

    const trimmed = template
        .replace(/^\{name\},?\s*/, "")
        .replace(/,\s*\{name\}/, "")
        .replace(/\s*\{name\}/, "");

    // Recapitalise: dropping a leading name promotes the next word to first.
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
