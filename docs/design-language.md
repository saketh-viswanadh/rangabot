# Rangabot design language

Rangabot's interface follows a quiet-craft principle: every mark should feel
deliberate, useful and calm enough to disappear once understood.

## Icon construction

- Draw on a 20 by 20 grid with a 1.35 pixel optical stroke.
- Prefer open contours, rounded joins and negative space over filled symbols.
- Use one metaphor for one action everywhere; never substitute emoji or a font
  glyph whose appearance changes by operating system.
- Colour communicates state only. The underlying geometry must remain legible
  in monochrome and across every Rangabot palette.
- Motion is acknowledgement, not decoration: a half-pixel lift on hover and no
  continuous icon animation.

The canonical implementation is `app/components/craft-icon.tsx`. Extend that
component instead of adding a one-off symbol to a page.

## Craft principles

1. **Purpose before ornament.** A mark exists only when it clarifies an action,
   state or destination.
2. **Ma (useful space).** Controls retain breathing room and do not compete with
   the conversation.
3. **Consistency over novelty.** Stroke, scale and interaction remain stable
   throughout chat, Knowledge Brief and Path to Mastery.
4. **Honest materials.** Icons are local SVG geometry with no runtime font,
   tracking request or external dependency.
5. **Visible care.** Keyboard focus, reduced motion, contrast and touch size are
   part of the design rather than later corrections.

## Review checklist

- Does an existing icon already express the action?
- Is the icon decorative, or does it have an accessible label on its control?
- Does it remain clear at 14 pixels and in light and dark palettes?
- Does the control work without relying on colour or animation?
- Has the old Unicode or emoji symbol been removed rather than hidden?
