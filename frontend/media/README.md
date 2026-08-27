# Landing page imagery

Five slots on the landing page render an image if — and only if — a picture has
been put in the slot. Leave one empty and the page renders without it, with no
broken image and no empty frame.

**Put a picture in from the console.** Sign in as the platform operator, open
**Platform**, and use *Pictures on the landing page*. Each slot says where it
lands, what it has to show and what size to export at. The picture is live
immediately — there is no restart, because presence is a cache the upload
invalidates rather than a check made once at boot.

Dropping a file into this directory by hand still works and is still picked up.
It is the older way and it is not the easier one: on a deployed container this
directory is inside the image, so a file put here by hand is lost on the next
redeploy. **Set `SITE_MEDIA_PATH`** to a directory on the volume and uploads
survive one.

The slots themselves — where each lands, its alt text, its dimensions — are
declared in `backend/src/site/media.ts`. That is the single source: the page
that renders them, the route that accepts them and the operator's screen all
read it, so the table below is a description rather than a second list.

| Slot | Where it lands | Orientation | Export at |
|---|---|---|---|
| `command-centre` | Full-width plate, immediately after the hero | Landscape ~3:2 | 2400×1600 |
| `broken-workflows` | Full-width band opening the proof section | Landscape ~3:2 | 2400×1600 |
| `visibility-control` | Column figure beside the engine grid | Portrait ~4:5 | 1120×1400 |
| `control-every-variable` | Column figure beside the statute passage | Portrait ~4:5 | 1120×1400 |
| `founder` | Portrait plate above the closing call to action | Portrait ~4:5 | 1120×1400 |

## What a picture has to be

**PNG, JPEG or WebP, and the platform reads that from the file rather than from
what the upload claims.** An SVG is refused outright: it is a document that can
carry script, and this directory is served from the platform's own origin, so
accepting one would be storing cross-site scripting on the marketing site. The
stored extension comes from the verified type, so a JPEG dropped into a slot is
stored and served as a JPEG.

**Under 8MB**, or `SITE_MEDIA_MAX_BYTES` where a deployment sets it. The ceiling
exists so the marketing page cannot fill the volume the ledger journal is also
writing to.

**Same origin, always.** The public-site content-security-policy is
`img-src 'self' data:`. An image referenced from any other host is blocked by
the browser, silently. Serving our own files from here is also what keeps the
page's original promise intact: no third party learns who read it.

**Export at twice the display width, then compress.** The landscape slots
display at up to 1200px, the portrait ones at up to 560px, which is where the
export sizes above come from. Anything larger is bytes nobody sees.

**Dimensions must match the ones declared for the slot.** They reserve the space
before the bytes arrive; if they disagree with the real file the page reflows as
each image lands.

## What is in these files matters more than where they go

Any figure printed *inside* an image is a figure no test can reach. The rest of
this page reads its numbers from the product — route counts, catalogue sizes,
the seeded project's real shape — precisely so a landing page cannot drift into
claiming something the software does not do. A percentage baked into a JPEG is
outside that guarantee, and it is the reader who cannot tell the difference.
