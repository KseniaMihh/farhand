# 0033 — Tailwind for arrangement, classes for the rules

## Context

#93 chose plain CSS and no framework, and was right to at the time: there was
one screen, and a styling framework is easier to choose once the choice is
about something. That reasoning lived in a comment at the top of
`farhand-web/app/globals.css` rather than in a record here, which is part of
why this one exists — a choice with no record is one nobody can supersede.

By #158 there were four screens and 781 lines of hand-written CSS, with six
more screens planned. The cost of converting rises with every one of them, so
"later" was the expensive answer rather than the cautious one.

The design system makes this an unusually clean migration *and* an unusually
awkward one, for the same reason. Clean, because Tailwind v4's `@theme` is
literally CSS custom properties, so a palette already written as tokens moves
across as a rename. Awkward, because that palette carries accessibility rules
about **where a colour may be used**, transcribed from the design file with
their ratios:

> White on Terracotta is **3.7:1** — under 4.5, so bold or large only, never
> body text. Sage Whisper takes **Pine text only** — 5.3:1.

## Decision

**Tailwind v4, and a hybrid that is deliberate rather than a halfway house.**

| | |
|---|---|
| **Utilities** | Arrangement: layout, spacing, flex and grid, responsive, one-off alignment |
| **Component classes** | Anything carrying a rule: `.btn` and its variants, `.input`, `.badge`, `.avatar`, `.wordmark`, and the four status tints |

The line is not "complex things get a class". It is **a class earns its name
when it encodes a decision, and does not when it only means sixteen pixels of
padding.**

`className="btn btn-offer"` enforces the 3.7:1 rule.
`className="bg-terracotta text-white"` does not — it would let somebody set
white body text on terracotta next month with nothing anywhere complaining.
The ratio came out of the design sheet rather than out of taste, so it keeps
a name, and it keeps its comment beside the token it constrains.

The component classes live in `@layer components`, so a utility still wins
where a caller means it to. That layering is what makes the hybrid work
rather than fight.

**Rejected: utilities everywhere.** The common advice, and it would cost the
paragraph above. Every contrast pair would become two independent utilities
that somebody can change one of.

**Rejected: `@apply` for the component classes.** It looks like the tidy way
to have both, and it hides the thing worth seeing: an `.btn-offer` written as
`@apply bg-terracotta text-white` reads as a shorthand rather than as a rule,
and the comment explaining the ratio has nowhere natural to sit. Plain CSS
properties inside the layer say what they mean.

**Rejected: staying on plain CSS.** Defensible — it worked, it was
documented, and this is a project with a standing rule against unnecessary
work. It loses on a narrow point: the person writing the next six screens
already speaks Tailwind, and will write them faster in it than in CSS whose
class names they would have to keep inventing.

## Consequences

- **Nothing may look different.** The conversion was checked against nine
  screenshots taken before it. Eight were pixel-identical; the ninth was a
  real regression and is the entry below.
- **A global `main { margin: 0 auto }` was centring every page at once.**
  Moving it into the `(site)` layout left `app/not-found.tsx` — deliberately
  outside that layout — hard against the left edge. The build, the types and
  all 59 tests were green. Only the before-and-after comparison said
  anything, which is the argument for taking the baseline first.
- **The faces are `--font-serif-face` and `--font-sans-face`.** Tailwind owns
  `--font-serif`; a token written in terms of itself is a loop that renders
  as Times New Roman.
- **The type scale survives whole.** Each role was one `font` shorthand, and
  v4's `--text-x--line-height` and `--text-x--font-weight` modifiers carry
  all three parts, so `text-lead` is still the whole of "Lead 18/28" rather
  than three utilities a reader has to reassemble.
- **`app/(site)/page.module.css` stays a module.** Shared things live in
  `globals.css`; one screen's things live beside that screen. It points at
  the theme's variables, so a colour changed in `@theme` changes there too.
  It most likely becomes a shared `.card` the moment a second screen wants
  one, and that is the issue that should move it.
- **Phone width is unverified and deliberately unfinished.** The browser
  tooling's viewport would not follow the window, and the project's priority
  is the desktop view until the screens exist. The responsive classes are
  written; nobody has looked at them. Said plainly here so that "it is
  responsive" is not later read off this record as something that was
  checked.
- **No dark mode, unchanged from #93.** A designed palette with measured
  contrast has no dark half, and guessing one means shipping pairs nobody
  checked.
