# Backlot brand

The boards in this folder are the source of truth for how Backlot looks: `identity.jpg` (logo, palette, type,
website hero), `guidelines.webp` (logo rules, graphic elements, taglines), `product-ui.webp` (the app), and
`video-creator.webp` (title cards, thumbnails, watermarks).

## In the code
| What | Where |
|---|---|
| Colour tokens, fonts, `meta-label`, `brand-dash`, `script` | `web/src/styles.css` |
| Logo, B mark, app icon, "Ideas / Scenes / Stories / Reality" | `web/src/components/brand/Logo.tsx` |
| Favicon | `web/public/favicon.svg` |
| App shell (sidebar, top bar) | `web/src/components/layout/StudioShell.tsx` |
| Footer bar | `web/src/components/layout/SiteFooter.tsx` |

## Palette
| Name | Hex | Use |
|---|---|---|
| Cinema Black | `#0F0F0F` | the stage: app and hero backgrounds |
| Projection Ivory | `#F4F1E5` | text on dark; light bands and legal pages (`.theme-ivory`) |
| Studio Orange | `#FF5E2A` | the one action colour: buttons, active states, the dash |
| Marquee Yellow | `#F7C342` | highlights and warnings ("ready for your approval") |
| Celluloid | `#8F3F32` | warm support colour, charts |

Use the tokens (`bg-primary`, `text-ivory`, `bg-cinema`, `text-warning`…), never raw hex values in components.

## Type
- Headlines: **Neue Haas Grotesk** (bold). It's a commercial font: until it's licensed, **Inter Tight** (bundled)
  stands in. Once you have the webfont files, add an `@font-face` for "Neue Haas Grotesk Display" and it takes
  over automatically (it's first in `--font-display`).
- Interface: **Inter**. Wordmark and title cards: **Anton** (a free condensed face close to the logo lettering).
  Taglines: **Caveat** (hand-written). All bundled with `@fontsource`, so no font CDN.

## Logo
- The B mark and wordmark are drawn in code (`<Logo />`, `<BMark />`, `<AppIcon />`), so they stay sharp at any
  size and take the text colour. The play triangle is always Studio Orange.
- Don't stretch it, recolour the triangle, split the lockup or add effects (see "Incorrect usage" on the board).
  For print or partners, get the vector master from the designer: the in-code version is a close redraw.

## Voice
Taglines: "Make something worth watching." · "Same stories. New worlds." · "Ideas into reality." ·
"An open studio for every story." · "Create what's next."
