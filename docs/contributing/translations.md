# Translations and RTL

Identify the active screen before translating. The current workspace is `packages/core-ui/`; legacy Next.js text and early fixture catalogues are not automatically the source for the current screen.

Core UI contains both shared catalogues such as `packages/core-ui/src/catalogs.ts` and feature-specific copy modules. Trace the screen's imports and language selection, then update the matching keys across supported catalogues. Do not create another translation framework or translate identifiers, schema keys or stored values.

Preserve placeholders, plurals, interpolation, accessible labels and locale formatting. Use logical layout properties; test Arabic RTL, long labels, mixed-direction names/paths, keyboard navigation and narrow layouts. Mark unreviewed translations honestly; machine output does not establish human review.

For an extension, inspect its existing i18n resources and the runner's translation loader. Document where the strings are consumed and which locale/fallback checks ran. Core UI typecheck and affected locale/layout tests must pass.
