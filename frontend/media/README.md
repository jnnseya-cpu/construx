# Landing page imagery

Five slots on the landing page render an image if — and only if — the matching
file is present in this directory. Drop the file in, restart the process, and
the slot appears. Leave it out and the page renders without it, with no broken
image and no empty frame.

Presence is checked once at boot rather than per request, because the landing
page is rendered on every visit and a filesystem stat per visit is a cost with
no reader-visible benefit. That is why a new file needs a restart.

| File | Slot | Orientation | Renders as |
|---|---|---|---|
| `command-centre.png` | After the hero | Landscape ~3:2 | Full-width product plate |
| `broken-workflows.png` | Opening the proof section | Landscape ~3:2 | Full-width band |
| `visibility-control.png` | Beside the engine grid | Portrait ~4:5 | Column figure |
| `control-every-variable.png` | Beside the statute passage | Portrait ~4:5 | Column figure |
| `founder.png` | Above the closing call to action | Portrait ~4:5 | Credibility plate |

## Rules these files have to meet

**Same origin, always.** The public-site content-security-policy is
`img-src 'self' data:`. An image referenced from any other host is blocked by
the browser, silently. Serving our own files from here is also what keeps the
page's original promise intact: no third party learns who read it.

**Export at twice the display width, then compress.** The landscape slots
display at up to 1200px, the portrait ones at up to 560px. Ship 2400px and
1120px respectively. Anything larger is bytes nobody sees.

**Dimensions must match the `width`/`height` attributes in `landing.ts`.**
Those attributes reserve the space before the bytes arrive; if they disagree
with the real file the page reflows as each image lands.

**Alt text lives in `landing.ts`, not here.** It is written per slot and
describes what the image shows, not what the file is called.

## What is in these files matters more than where they go

Any figure printed *inside* an image is a figure no test can reach. The rest of
this page reads its numbers from the product — route counts, catalogue sizes,
the seeded project's real shape — precisely so a landing page cannot drift into
claiming something the software does not do. A percentage baked into a JPEG is
outside that guarantee, and it is the reader who cannot tell the difference.
