# Frontend design foundations

The shared tokens live in `src/index.css`; existing Tailwind color names remain
available. `ui.css` only targets the new primitives and modal surfaces. Screen
layouts, branding, domain statuses, matching policy and request ownership stay
with their existing components.

## Tokens

- Canvas / muted surface: `#F7F8FA`; working surface: `#FFFFFF`.
- Text: `#17212F`; supporting/disabled text: `#526071`.
- Action / focus: `#1D4ED8`; action hover: `#1E40AF`; selected: `#EFF6FF`.
- Divider: `#DDE2E8`; field/button border: `#7C8798`.
- Success: `#166534` on `#F0FDF4`; warning: `#92400E` on `#FFFBEB`;
  error: `#991B1B` on `#FEF2F2`; destructive hover: `#7F1D1D`.
- Inter with existing system fallbacks; existing JetBrains Mono/Fira Code
  fallbacks for structured examples. Text sizes: 12px metadata, 13px supporting
  labels, 14px operational body, 16px reading, 18px section, 24px page. Body
  line-height 1.5; heading line-height 1.35. Mobile fields use 16px.
- Spacing: 4, 8, 12, 16, 24, 32px. Radius: 4px status, 6px control, 8px dialog.
  Controls: 40px desktop, 44px under 600px. Borders: 1px. Focus: 2px blue
  outline with a 3px offset. Only dialogs use a subtle 8px/24px shadow.

All starting palette colors are retained. Hover colors and a 42% neutral backdrop
are additions. Disabled controls keep readable text instead of fading their
entire contents. Token tests check text combinations against 4.5:1 and field/
focus boundaries against 3:1; Chromium also checks effective rendered styles.
These targets and tests do not establish WCAG certification.

## Primitives and adoption

- `Button`: primary, secondary, quiet and danger; native disabled/loading,
  default `type="button"`, required accessible name for icon-only buttons.
  Loading preserves caller-supplied text; its spinner is decorative and static
  under reduced motion.
- `Field`, `TextInput`, `Textarea`: native controls and label/hint/error wiring.
  Validation descriptions are not separate urgent live regions.
- `StatusIndicator`: visible text with caller-supplied semantic tone. Live
  announcements are opt-in. No matching or decision policy is embedded.
- `InlineFeedback`: polite status for ordinary feedback; alert for actual errors.
- `Dialog`: native modal in a body portal. The screen owns `open` and dismissal
  restrictions. Native modal behavior blocks background interaction; a small
  keyboard boundary handler keeps forward/backward Tab inside the current DOM.
  Focus enters a supplied control, repairs on control removal/disable, and
  returns to the initiating control or a supplied ref. Removed/disabled triggers
  fall back to the compact workflow menu, an application button, or the body.
  Native cancel never changes parent state directly. Scroll styles and observers
  are restored on close/unmount.

AI retains its submission generation guard, editable note, accepted Job,
unknown-outcome blocking and recovery. CSV help retains the existing template,
native file chooser and import state. Credentials retain explicit native rotation
confirmation and one-time discard; Escape closes/discards the displayed value.
Copy feedback is inside the active modal, without a duplicate background live
region. No credential persistence, logging or request changes were added.

A separate SectionHeading abstraction was deferred: shared dialog title styling
already removes the duplication in these surfaces. General screen headings can
adopt tokens in later presentation phases.

## Validation and limits

Run `node node_modules/typescript/bin/tsc -b --noEmit`, `npm test`,
`node node_modules/eslint/bin/eslint.js src smoke playwright.safety.config.mjs`,
and `node node_modules/@playwright/test/cli.js test --config playwright.safety.config.mjs`.
The browser suite uses offline boundaries and synthetic API fixtures only.
Override its output directory to `.system_generated/phase3b/browser` for captures.

jsdom only shims `showModal`/`close`; real keyboard containment, background
inertness, responsive scrolling and focus restoration are checked in Chromium.
Native modal support is required. Nested simultaneous modal workflows are not
part of current screen behavior or this validation. Screen-reader testing, other
browser engines, real phones/virtual keyboards, and application-wide accessibility
remain later validation work. No new routes or screen redesigns are introduced.
