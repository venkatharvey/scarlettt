/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  // Dark theme is driven by `data-theme="dark"` on <html> (set by useTheme), not the
  // `.dark` class — so `dark:` variants and the token overrides key off the same
  // attribute. Kept available for the few status colours that stay easier as
  // `dark:` variants than as tokens.
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      // Inter is the only typeface in the app. The rest of the stack is the
      // fallback chain for when it hasn't loaded — see index.html.
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      // Semantic design tokens — defined once in src/css/index.css, swapped per theme
      // there. `rgb(var(--x) / <alpha-value>)` is what makes `bg-surface`, `text-fg`,
      // `bg-inverse/70` etc. all work, opacity modifiers included.
      colors: {
        chatgrey: "#A0A0A0",
        fg: 'rgb(var(--fg) / <alpha-value>)',
        'fg-secondary': 'rgb(var(--fg-secondary) / <alpha-value>)',
        'fg-muted': 'rgb(var(--fg-muted) / <alpha-value>)',
        'fg-faint': 'rgb(var(--fg-faint) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        raised: 'rgb(var(--surface-raised) / <alpha-value>)',
        card: 'rgb(var(--surface-card) / <alpha-value>)',
        hover: 'rgb(var(--surface-hover) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        'line-strong': 'rgb(var(--line-strong) / <alpha-value>)',
        inverse: 'rgb(var(--inverse) / <alpha-value>)',
        'inverse-fg': 'rgb(var(--inverse-fg) / <alpha-value>)',
        'inverse-hover': 'rgb(var(--inverse-hover) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'good-bg': 'rgb(var(--good-bg) / <alpha-value>)',
        'good-fg': 'rgb(var(--good-fg) / <alpha-value>)',
        'good-line': 'rgb(var(--good-line) / <alpha-value>)',
        'warn-bg': 'rgb(var(--warn-bg) / <alpha-value>)',
        'warn-fg': 'rgb(var(--warn-fg) / <alpha-value>)',
        'warn-line': 'rgb(var(--warn-line) / <alpha-value>)',
        'bad-bg': 'rgb(var(--bad-bg) / <alpha-value>)',
        'bad-fg': 'rgb(var(--bad-fg) / <alpha-value>)',
        'bad-line': 'rgb(var(--bad-line) / <alpha-value>)',
        'info-bg': 'rgb(var(--info-bg) / <alpha-value>)',
        'info-fg': 'rgb(var(--info-fg) / <alpha-value>)',
        'info-line': 'rgb(var(--info-line) / <alpha-value>)',
      },
    },
  },
  plugins: [],
}