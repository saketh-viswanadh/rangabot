# Rangabot responsive identity assets

Founder-approved visual direction, 2026-08-14.

## Public repository payload

- `public/brand/rangabot-primary-{64,192,512}.png`: browser, touch, product and
  repository identity.
- `public/brand/rangabot-chat-mark{,-light,-dark}.svg`: compact assistant mark
  source plus explicit product theme variants.
- `public/brand/rangabot-spark.svg`: restrained welcome and generation accent.
- `desktop/assets/rangabot-primary-1024.png` and `rangabot.icns`: canonical
  macOS source and compiled application icon.

These files are copied byte-for-byte from the finalized company brand pack.
This manifest documents them without creating a second binary copy under
`docs/`.

## Responsive usage hierarchy

- Archival master: preserve in the governed company brand source.
- 1024 px primary: desktop/application icon source at
  `desktop/assets/rangabot-primary-1024.png`.
- 512 px primary: website and public repository branding; tracked at
  `public/brand/rangabot-primary-512.png` for the core product and README.
- 192 px primary: PWA/touch icon.
- 64 px primary: small public-surface preview.
- Responsive light/dark chat mark: 18–24 px beside Rangabot assistant responses
  and in compact product identity locations. Do not place it in a second
  circular or rounded-square container.
- Conversation spark: optional 12–16 px accent for rotating thoughts or jokes,
  active thinking and rare greeting transitions. Do not attach it to every
  message or chat-mark instance.

Product-owned variants are intentionally not duplicated in this docs-only
directory. The current wide Charter sharing card also remains unchanged; a
square primary mark is not a drop-in social-preview replacement.

## Color tokens

| Token | Light | Dark |
| --- | --- | --- |
| Gold | `#D4A13A` | `#E6C483` |
| Profile | `#FCF7EF` | `#CFC6B6` |
| Ink | `#1F3D2E` | `#263F36` |

## Rights boundary

These identity files are proprietary Rangabot assets approved for official
product use. Rangabot reserves all trademark rights in the name and identity
set, and no redistribution license is granted for these files. Do not infer a
grant from the Apache-2.0 terms for code and documentation or from the separate
CC BY 4.0 terms for the earlier Ranga artwork.

See [`README.md`](README.md) for provenance and
[`BRANDING.md`](../../../BRANDING.md) for licensing and trademark boundaries.
