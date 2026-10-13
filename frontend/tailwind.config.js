/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "var(--border)",
        background: "var(--background)",
        surface: "var(--surface)",
        "surface-muted": "var(--surface-muted)",
        foreground: "var(--foreground)",
        muted: "var(--muted)",
        "field-border": "var(--field-border)",
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          muted: "var(--accent-muted)",
          contrast: "var(--accent-contrast)",
        },
        success: { DEFAULT: "var(--success-text)", subtle: "var(--success-bg)" },
        warning: { DEFAULT: "var(--warning-text)", subtle: "var(--warning-bg)" },
        danger: { DEFAULT: "var(--danger-text)", subtle: "var(--danger-bg)" },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
}
