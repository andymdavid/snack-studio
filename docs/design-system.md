# Snack Studio Design System

Snack Studio combines Citadel's compact operating-interface grammar with the Intelligence Snacks visual identity. This document is the implementation contract for future screens.

## Sources of truth

- Citadel supplies information density, shell behavior, spacing, controls, cards, tables, status patterns, responsive collapse, and UI typography.
- Intelligence Snacks supplies the light palette, coral brand accent, Neue Montreal display typography, square geometry, and editorial character.
- The semantic tokens at the top of `public/styles.css` are the executable source of truth. Product CSS should consume those tokens rather than introduce isolated colour values.

## Principles

1. This is an editorial operating tool, not a replica of the public website. Use the public identity with Citadel's compact application ergonomics.
2. Keep the canvas quiet: white panels on a soft off-white background, black primary text, and fine neutral borders.
3. Coral is scarce. Use it for the primary action, focus, selected emphasis, and meaningful brand moments—not as general decoration.
4. Use status colours only for state. Never rely on colour alone; pair it with a label or icon.
5. Prefer borders and surface shifts to large shadows. Motion should be short, functional, and removable through reduced-motion preferences.
6. Preserve a clear distinction between save, editorial approval, publication, and deployment. Destructive or irreversible actions require explicit labels and confirmation.

## Foundations

### Colour

| Role | Token | Value |
| --- | --- | --- |
| Canvas | `--paper-raised` | `#f7f7f4` |
| Panel | `--paper` | `#ffffff` |
| Primary text | `--text-primary` | `#000000` |
| Secondary text | `--text-secondary` | `rgba(0,0,0,.72)` |
| Muted text | `--text-muted` | `rgba(0,0,0,.58)` |
| Border | `--border` | `rgba(0,0,0,.12)` |
| Strong border | `--border-strong` | `rgba(0,0,0,.22)` |
| Brand / focus | `--coral` | `#fe7141` |
| Success | `--success` | `#16734a` |
| Warning | `--warning` | `#8a5a00` |
| Danger | `--danger` | `#b53716` |
| Information | `--info` | `#215f9a` |

Topic colours belong to editorial content and thumbnail backgrounds. They do not replace UI semantic colours.

### Typography

- Neue Montreal is the display face for page and section headings.
- Geist is the interface and body face.
- Geist Mono is reserved for IDs, timestamps, counts, versions, hashes, run state, and tabular figures.
- The operating scale is `11 / 12 / 13 / 15 / 22 / 26px`. Larger editorial type is appropriate only for intentional empty states or preview content.
- Default body copy is 13px at 1.5 line height. Long-form snack and transcript editing surfaces may use 15–16px.

### Shape, spacing, and elevation

- Controls and cards use a 3px radius, matching Intelligence Snacks.
- Base spacing is 4px. Normal component gaps are 8 or 12px; panel padding is 12 or 16px; page padding is responsive between 16 and 72px.
- Use a one-pixel neutral border as the default elevation. Shadows are reserved for overlays and floating menus.
- Standard controls are at least 30px high. Primary touch targets must expand toward 40–44px on narrow/mobile layouts.

## Application grammar

- Desktop navigation uses Citadel's 236px sidebar, 64px top bar, breadcrumb, and scrollable content region.
- Pages should have one clear title, optional compact tabs, then cards/tables/work surfaces.
- Cards are either standard (16px padding) or compact (12px). Avoid nested cards when a divider or grouped rows will do.
- Tables use compact 32px headers and approximately 42px rows. On small screens, convert complex tables into labelled cards rather than horizontal compression.
- The primary filled button is coral. Secondary buttons use a neutral raised surface. Tertiary actions are transparent. There should normally be only one filled primary action in a local decision area.
- Status pills have light backgrounds, readable text, and explicit wording such as Draft, In review, Failed, or Published.
- Empty, loading, error, and retry states are designed states, not afterthoughts.

## Editorial workflow rules

- Candidate review state and public publication state must use separate labels and controls.
- Accept/reject actions must remain visually distinct from publish/deploy actions.
- Transcript evidence, provenance, pipeline version, and timestamps use compact metadata styling and mono figures.
- Thumbnail review gives the image visual priority while keeping evidence and decisions in a stable side panel or lower rail.
- Preview surfaces may adopt more of the public Intelligence Snacks typography, but surrounding Studio controls stay within this operating system.

## Accessibility and responsive behavior

- All interactive elements require a visible coral focus ring.
- Maintain WCAG AA contrast for normal text and controls. Soft semantic backgrounds must retain dark readable labels.
- Do not communicate status, selection, or validation by colour alone.
- Respect `prefers-reduced-motion`.
- At 820px and below, collapse the application shell to one column, reduce page padding to 16px, stack grids, and increase critical touch targets.
- Editing layouts should become a single-column sequence rather than squeezing preview and form panes side by side.

## Contribution rule

Before adding a new colour, radius, shadow, font size, or interaction pattern, first determine whether an existing semantic token or primitive covers the need. If a genuinely reusable role is missing, add and document a semantic token; do not hard-code a page-specific value.
