# DESIGN.md: IMD Sport Intelligence

Taken from `src/styles.css`, `src/App.tsx`, `src/art.tsx` and `src/wallet.tsx` as built.

## Direction

Premium black, gold and electric blue. Black carries the page, gold marks the one main action and key
numbers, blue marks secondary actions and the away/model line. Analysis tone: numbers first, plain words.

## Color tokens

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#07080b` | page |
| `--surface` / `--surface-2` | `#101218` / `#161922` | cards, controls, tabs |
| `--line` | `#262a35` | 1px borders and dividers |
| `--text` | `#f2efe6` | body and headings |
| `--muted` | `#a9adb8` | secondary text (passes 4.5:1 on `--bg` and surfaces per the taste probe) |
| `--gold` / `--gold-hi` | `#d9b45a` / `#e9c977` | primary button, scores, big figures, home share, the result marker |
| `--blue` / `--blue-hi` | `#3d9bff` / `#6bb4ff` | links, secondary button, away share, reliability line |
| `--red`, `--green` | `#ff7a6b`, `#5fd08a` | unavailable / final badges, errors / success notes |

Status badges: Final (green), Live (blue), Scheduled (gold), Stale (orange `#ffb37a`), Unavailable (red),
Historical (muted).

## Typography

System sans (`ui-sans-serif, system-ui, …`) for everything; system mono only for addresses, hashes and
event IDs. Weights 400, 600, 800. One scale of six sizes: `--t1` 13px (meta, tables), `--t2` 15px (body),
`--t3` 17px (lede, h3, phone fixture names), `--t4` 21px (h2), `--t5` 28px (h1 on phones, scores, figures),
`--t6` 40px (h1 from 900px). Headings tighten to -0.02/-0.03em; content tracking is natural; tabular
numerals for every number.

## Spacing and shape

4/8/12/16/24/32/48px steps (`--s1`…`--s7`), radius 10px for cards, 999px for buttons and tabs, max width 1120px.

## Components

- **Header:** logo and name at left, Connect at right; text nav (Accuracy, History, Status) from 900px;
  a sport row under it at all widths; the footer repeats the three links for phones.
- **Buttons:** `.btn-gold` (one main action per view), `.btn-blue`, `.btn-quiet`; 44px min height; hover,
  pressed and `:focus-visible` (2px ring) states.
- **Match card:** badges, competition line, three-column fixture with gold score, probability bar
  (gold/grey/blue) and a legend that marks the result.
- **Tabs:** pill links per sport view (`aria-selected`), gold when current.
- **Unavailable notice:** badge plus one bold line and what activation it needs.
- **Tables:** `.tbl` with muted headers; scroll inside their own box under 640px.
- **Reliability chart:** inline SVG, diagonal reference, bins as gold dots sized by count, native tooltips.
- **Connect sheet:** bottom sheet under 640px, centered above; 48px rows, EIP-6963 wallets by name and
  icon, WalletConnect only when configured, "Open in MetaMask" on phones; Escape, backdrop and × close it.
- **Artwork:** original SVG plates (octagon, rink, gridiron, court, tennis court, pitch) and the hexagon
  logo with a rising blue line; no third-party imagery.

## Responsive behavior

- Under 640px: one column; card buttons full width; tables scroll in place; sport grid two columns.
- 640px+: sport grid three columns, stats three columns, facts two columns; sheet centered.
- 900px+: header nav appears; home hero becomes two columns (copy left, featured match right); h1 at 40px;
  accuracy chart and bin table side by side.
- `prefers-reduced-motion` removes transitions. No animation runs continuously.
