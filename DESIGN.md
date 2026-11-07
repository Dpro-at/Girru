# Workspace design reference

The current desktop workspace is the React/TypeScript interface in
`packages/core-ui/`. Use its existing components and CSS variables when changing
a screen. The retained Next.js application and test fixtures are separate surfaces.

## Sources

- [Workspace styles](packages/core-ui/src/styles.css): theme tokens, shell layout,
  controls, focus states, responsive rules and feature stylesheet imports.
- [Navigation](packages/core-ui/src/app-navigation.ts): workspace destinations.
- [Visual adjustments](packages/core-ui/src/visual-fixes.css): screen-specific rules.
- [Desktop pages](packages/desktop/src/pages/): startup and failure surfaces with
  their own styles and lifecycle.
- [Shared assets](packages/core-ui/assets/): workspace media and icon assets;
  retain their licence and provenance records.

## Themes and typography

Reuse semantic variables such as `--canvas`, `--surface`, `--text`, `--muted`,
`--border`, `--accent` and `--danger`. The light theme's base accent is `#0053FD`;
the dark theme's is `#4A84FE`. Later workspace selectors override some base
colours and layout values, so inspect the full cascade for the actual screen.
Do not copy an unrelated prototype's palette into a shared theme.

The base interface uses the platform system font stack. Arabic selectors add
Arabic font fallbacks. Preserve these stacks and check mixed Arabic/English text,
paths and numbers rather than assuming a named font is bundled.

## Interaction and layout

Reuse the shell's navigation, panes, forms and status surfaces. Keep loading,
empty, denied, disconnected and error states distinct. UI state displays backend
results and submits intent; it does not grant permissions or execute agent work.

Preserve visible keyboard focus, accessible names, logical layout properties,
coarse-pointer targets and reduced-motion/forced-colour rules. Check light/dark
themes, Arabic RTL, narrow layouts, long labels and keyboard navigation for the
changed screen. Native surfaces also need host-specific acceptance.

See [architecture boundaries](docs/architecture/overview.md),
[translations](docs/contributing/translations.md) and
[validation](docs/contributing/testing.md). Source presence and screenshots do not
establish that a capability has shipped.
