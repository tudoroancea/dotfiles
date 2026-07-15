---
name: typst-local
description: Create, edit, compile, format, preview, and visually review local Typst papers, reports, theses, posters, and Touying slide decks. Use when starting or maintaining a .typ project, choosing a publication template, debugging Typst-vs-LaTeX issues, building Touying animations or handouts, or making native Lilaq plots.
compatibility: Requires a local Typst compiler. Tinymist, typstyle, pdftoppm, and Pi image-inspection tools are optional but recommended.
---

# Local Typst documents

Treat the source, the compiled artifact, and visual inspection as one workflow. Do not claim a layout change is finished after only reading source or obtaining a successful compile.

## Start by establishing the project

For an existing project:

1. Read the nearest `AGENTS.md`, `CLAUDE.md`, README, manifest, and main `.typ` entry point before editing.
2. Identify the actual entry point, project root, pinned package versions, template/theme, bibliography, fonts, data files, and existing compile command. Do not assume the currently open `.typ` file compiles standalone.
3. Compile once before editing. Preserve the existing output name, root, input flags, and local conventions.
4. Inspect comparable components before adding a new slide, figure, theorem, table, or template function.

Useful read-only inspiration on this machine:

- `~/Desktop/misc/epfl-ma-ba/master-thesis/slides/`: Touying University theme, CeTZ/Fletcher reducers, and pause-based slides.
- `~/Desktop/misc/epfl-ma-ba/master-thesis/report/`: a small EPFL report template function.
- `~/Desktop/phd/candidacy/`: a local EPFL Touying theme, handout/subslide controls, shared Lilaq plot conventions, and report/slide reuse.

Read these for patterns only. Never edit them unless the user explicitly names one as the target project. Prefer the target project's conventions over these examples.

## Interview before kickstarting a project

Do not choose a template or visual direction from a vague request. Ask the unknowns in one compact batch, preferably with the questionnaire tool:

1. **Artifact and venue:** slides, paper, report, thesis, poster, notes; exact venue/institution and required template (IEEE, ACM, Springer, EPFL, arXiv, internal, or none).
2. **Audience and job:** who will read/watch it, what they should understand or do, expected expertise, and whether compliance or persuasion matters more.
3. **Length:** page limit or talk duration, expected slide count, deadline, and draft maturity.
4. **Tone:** formal archival paper, sober conference talk, teaching deck, chill lab update, visual keynote, etc. Ask for references they like or dislike.
5. **Identity and constraints:** aspect ratio, logos, brand colors, fonts, accessibility, print/grayscale needs, anonymous review, and required sections.
6. **Inputs:** existing prose, outline, figures, `.bib`, data, code, and whether content may be rewritten.
7. **Presentation delivery:** animations, speaker notes, presenter software, second-screen layout, and handout requirements.
8. **Tooling/deliverables:** editor, CI, PDF/PDF-A/PNG requirements, collaboration model, and whether external package downloads are acceptable.

If the visual direction remains open, offer two or three concrete directions tied to the audience and subject, then get a choice. For example, distinguish “dense IEEE evidence-first,” “calm technical seminar,” and “high-contrast conference narrative”; do not ask only “formal or casual?”

Before scaffolding:

- Verify the exact venue's current author instructions. A Typst Universe package is not evidence that a venue accepts its output.
- Inspect the selected template's API and source, then pin its version. Do not guess function names from the package name.
- Use `typst init @preview/<template>:<version> <dir>` when a maintained template fits. Otherwise create the smallest local template function that satisfies the brief.
- Separate presentation/content from reusable styling when the theme is more than a few rules. Keep data and bibliography as source files, not pasted generated values.
- Create real representative content early; lorem ipsum does not expose equation, citation, plot, or slide-density problems.

## Typst is not LaTeX: important differences and gotchas

Do not transliterate LaTeX command-by-command.

- **Three modes matter.** Markup is the default; `#` enters code; `$...$` enters math. Square brackets create content values. A string (`"text"`) and content (`[text]`) are different types.
- **Display math is whitespace-sensitive.** `$x$` is inline, while `$ x $` or multiline delimiters produce display math.
- **Math is not TeX math.** Named symbols and functions do not use backslashes. Multi-letter bare words are identifiers; quote prose such as `$x "if" y$`. Group multi-part scripts with parentheses: `$x_(i + 1)$`. `/` forms a fraction, matrices use commas for columns and semicolons for rows, and code values may need `#` inside math.
- **Watch script/application ambiguity.** In expressions such as `$F_d (x)$`, a space can be necessary so `(x)` is not absorbed into the subscript. Inspect the rendering rather than trusting a LaTeX habit.
- **Functions replace macros/environments.** Calls have consistent positional/named arguments and can receive trailing content: `#rect(fill: red)[body]`. One-element arrays require a trailing comma: `(item,)`.
- **`set` and `show` are scoped transformations.** Their position and block scope matter. A `show` rule can recursively match its own output if written carelessly. Prefer a template function plus `#show: template.with(...)` over scattered global styling.
- **Context-dependent values require `context`.** Counters, locations, measurements, and queries are not ordinary eagerly available values. Do not add `context` blindly; isolate the smallest dependent expression.
- **Changing page setup can force a page break.** Repeated `set page(...)` is not a drop-in equivalent for temporary LaTeX geometry changes; use local layout tools such as `pad` when appropriate.
- **Imports and includes differ.** `#import` exposes definitions; `#include` inserts a file's content. File reads are constrained by the project root, so set `--root` deliberately rather than moving files or weakening structure.
- **Packages are source dependencies.** Pin `@preview/package:version`; the first compile may download it, later compiles use the cache. Do not silently upgrade packages while fixing unrelated content.
- **Labels, references, and citations share concise syntax.** `<label>` defines a label and `@label` references it; bibliography keys also use `@key`. Keep `.bib` when useful, but remember styling is CSL-based rather than BibLaTeX-based.
- **Source order is not always final page order.** Floats, counters, outline queries, and Touying subslides are resolved through layout. Verify page numbers and references in output.
- **Fonts are system-visible resources.** A compile succeeding on one machine does not prove CI portability. Check `typst fonts`, package font files when licensing permits, or pass a controlled `--font-path`.

When syntax or semantics are uncertain, consult the documentation matching the installed Typst and package version. Do not invent a LaTeX-like command.

## Tooling: compile, watch, preview, format, and lint

First check what is installed (`typst --version`, `tinymist --version`, `command -v typstyle`). This machine normally has Typst and Tinymist; standalone `typstyle` may not be installed.

Core commands:

```sh
# Deterministic final artifact
typst compile main.typ build/main.pdf

# Recompile on dependency changes and open the viewer once
typst watch main.typ build/main.pdf --open

# Project with reads/imports outside the entry file's directory
typst compile --root . path/to/main.typ build/main.pdf

# Inspect only physical pages 2 and 5-7, or emit raster pages directly
typst compile --pages 2,5-7 main.typ 'build/review-{0p}.png' --ppi 160

# Browser preview; slide mode is useful for decks
tinymist preview main.typ --preview-mode slide --open

# Static diagnostics beyond compilation
tinymist lint main.typ
```

Use `--input key=value` for build variants rather than editing a committed boolean before each build. `sys.inputs` values are strings.

Formatting:

- Prefer the project's configured editor formatter. In these dotfiles, Zed's Tinymist configuration uses `formatterMode: "typstyle"` and exports PDF on save.
- If standalone typstyle exists, use `typstyle --check .` in checks and `typstyle -i <paths>` to modify files. Review formatting diffs, especially around deliberately arranged math or tables.
- Tinymist embeds typstyle for editor formatting, but `tinymist format` is not a valid CLI command in the currently installed version.
- Do not install or switch formatters merely to complete a content edit. Do not enable markup wrapping if the project intentionally keeps one sentence per source line.

Use `typst watch` for a PDF viewer workflow, and Tinymist preview for rapid browser/cursor-linked iteration. Use a normal `typst compile` for the final check because preview success alone is not the deliverable.

## Visually inspect the output

After every meaningful layout change:

1. Compile the real entry point and stop on diagnostics.
2. Render affected pages to PNG. Prefer direct Typst PNG output; use `pdftoppm -png -r 160 build/main.pdf build/page` when the exact produced PDF must be rasterized.
3. Use `agentflow_look_at` on the affected pages with a specific objective, such as “check clipping, hierarchy, equation alignment, label collisions, plot legibility, and consistency with pages 3–5.”
4. For broad changes, inspect the title/first page, a dense text page, a math page, every changed figure, bibliography/end matter, and representative section transitions. For slides, inspect every animation state of each changed slide.
5. Fix, recompile, and reinspect. A successful compile does not catch overflow that is technically legal, tiny labels, bad page breaks, weak contrast, or animation jitter.

When comparing before and after, render both at the same PPI and inspect the same physical pages. Remember that Touying animation changes physical page numbers; identify logical slides by title/content, not only by PDF index.

## Touying presentations

Use Touying when the deck needs reusable themes, sections, presenter notes, handouts, or staged reveals. Pin the version and consult that version's docs; animation and reducer APIs have changed between 0.5, 0.6, and 0.7.

### Structure for efficient decks

- Put theme configuration and reusable slide variants in a local theme file once the chrome becomes nontrivial.
- Define semantic colors, diagram helpers, and plot helpers once. Keep slide bodies narrative and short.
- Keep `handout` controlled by `sys.inputs`, not a source edit:

```typ
#let handout = sys.inputs.at("handout", default: "false") == "true"
#show: my-theme.with(config-common(
  handout: handout,
  show-notes-on-second-screen: if handout { none } else { right },
))
```

Build with `typst compile --input handout=true slides.typ build/handout.pdf`.

### Animation mental model

Touying emits subslides as physical PDF pages. Plan a timeline before adding commands.

- `#pause` advances the serial reveal timeline.
- `#meanwhile` returns to a previous timeline position to synchronize parallel columns; it is not another serial pause.
- `#uncover("2-", body)` hides body while reserving its space. Prefer it when geometry must remain stable.
- `#only("2", body)` removes body and its space outside the selected step. Use it for true replacement, not ordinary progressive disclosure.
- `#alternatives(a, b, c)` is usually cleaner for swapping states and avoids much of the hand-written layout bookkeeping.
- Subslide indices are 1-based. Open ranges such as `"2-"` mean “from step 2 onward.” Verify newer index features against the pinned Touying version.

Prefer a few meaningful states over animating every bullet. Avoid reveals that merely slow reading.

### Handouts and animation debugging

Handout mode normally keeps only the last subslide. If intermediate states matter, select them explicitly. A useful per-slide pattern from the candidacy deck is:

```typ
#touying-set-config(config-common(handout-subslides: "1-"))[
  == A compiler — in action
  // all alternatives are retained in the handout
]
```

Do not enable this globally without considering PDF length.

For unexpected blank pages, wrong counts, or premature content:

1. Count pauses and intended states; check explicit `repeat` first in callback-style slides.
2. Replace `only` temporarily with `uncover` to distinguish timeline errors from reflow.
3. Check range boundaries (`2` versus `2-`) and compare normal and handout builds.
4. Remove the diagram reducer temporarily. CeTZ command arrays and Fletcher streams can require reducer-specific placement of animation commands.
5. Split overflowing animated content into separate logical slides. Do not debug a multi-page slide as if it were only an index issue.
6. Upgrade only as a deliberate change after checking the Touying changelog; ghost slides, notes, counters, and footnotes have had version-specific fixes.

For CeTZ/Fletcher, use the reducer API documented for the pinned version. Current Touying uses high-level forms like `touying-reduce.with(fletcher)`; older local decks use lower-level bindings such as:

```typ
#let fletcher-diagram = touying-reducer.with(
  reduce: fletcher.diagram,
  cover: fletcher.hide,
)
```

Do not mix these snippets across versions. Reducers translate animation commands inside diagram command streams; they do not make all Touying helpers safe in every diagram context. If callback methods require manual `repeat`, keep the count next to the slide and verify every generated page.

## Lilaq plots

Prefer Lilaq for modest, static, publication-quality plots whose typography and design should be native to the document.

Why use it instead of exporting Matplotlib by default:

- labels, equations, fonts, colors, spacing, and selectors are Typst-native;
- plots update in the same fast preview loop as prose;
- data, figure composition, and styling remain close to the document;
- reusable helpers and style cycles keep paper and slide figures consistent;
- text stays vector-quality and subplots compose naturally with Typst layout.

Use Matplotlib or a specialist tool instead for heavy preprocessing, very large data, unsupported projections/3D/specialized chart types, interactive exploration, or plots that are already a tested part of an analysis pipeline. Do not move scientific computation into Typst merely to avoid an exported figure.

### Practical Lilaq pattern

Pin Lilaq, load data once, and encode semantics in helpers rather than repeating style arguments:

```typ
#import "@preview/lilaq:0.6.0" as lq

#let data = lq.load-txt(read("data/results.csv"), header: true)
#let c-ours = rgb("#3F8FDA")
#let c-base = rgb("#FF5956")
#let plot-ours(x, y) = lq.plot(
  x, y, label: [ours], color: c-ours,
  stroke: (dash: "solid"), mark: "o", mark-size: 3pt,
)
#let plot-base(x, y) = lq.plot(
  x, y, label: [baseline], color: c-base,
  stroke: (dash: "dashed"), mark: "^", mark-size: 3pt,
)

#lq.diagram(
  width: 100%, height: 110pt,
  xlabel: [problem size $N$], ylabel: [runtime (ms)],
  plot-ours(data.n, data.ours),
  plot-base(data.n, data.baseline),
)
```

Prefer typed JSON when controlling the data export; it preserves numbers, arrays, strings, and metadata. Use `lq.load-txt` for existing CSV-like tables. Keep raw data under `data/`, and document units and preprocessing at the generation boundary.

For multi-panel paper figures, apply `#show: lq.layout` and compose diagrams with a Typst `grid`. For reusable global styling, follow Lilaq's selector/set helpers for the pinned version, for example `#show lq.selector(lq.diagram): ...`; custom element styling is version-sensitive.

Use automatic legends from plot `label` values unless a slide needs a compact custom legend. Give series redundant encodings (color plus marker/dash), especially for projection, grayscale printing, and color-vision accessibility. Let automatic ticks work unless domain meaning requires fixed ticks; manual ticks become stale when data changes.

Visually inspect plots at their final physical size. Check tick collisions, units, legend occlusion, line/marker distinguishability, clipping, false precision, and whether log scales or omitted series are explicitly disclosed.

## Completion checklist

Before finishing:

- compile the actual deliverable with the intended root, inputs, fonts, and package cache;
- run the configured formatter/check and Tinymist lint when available;
- inspect all changed pages as images, including every changed Touying subslide and the handout variant;
- verify citations/references, page or slide numbering, bibliography, image paths, and first-download package behavior;
- report the entry point, artifact path, commands run, and any unverified venue/font/tooling assumptions.

Primary references: [Typst docs](https://typst.app/docs/), [Typst guide for LaTeX users](https://typst.app/docs/guides/for-latex-users/), [Touying docs](https://touying-typ.github.io/), [Lilaq docs](https://lilaq.org/docs/), and [typstyle](https://github.com/typstyle-rs/typstyle).
