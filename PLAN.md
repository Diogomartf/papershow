# Papershow — Plan

An e-ink slideshow: **ImageGen** makes the images, **SlideGen** decides what is on `/live`, **ShowPi** puts it on the panel.

## The system

```
ImageGen (browser)  ──save scene──▶  SlideGen (server)  ──GET /live──▶  ShowPi (Pi 5 + Waveshare e-ink)
 draw + layout + bindings            store, schedule, run plugins,       fetch, push to panel
                                     render to 1-bit, serve /live        only when it changed
```

**Rule that makes it efficient:** all the work happens on the server. The Pi never renders, never runs a
browser, and never decodes anything heavy. It downloads a ready 800×480 1-bit frame (48 KB raw, a few KB
compressed) and redraws the panel only when the frame's hash has changed. E-ink refreshes are slow and
flash, so skipping identical frames matters more than anything else.

## Core decision: an image is a scene, not a PNG

A saved image is a JSON scene. A PNG is just one export of it.

```ts
type Scene = {
  id: string; name: string;
  width: 800; height: 480;              // matches the panel
  strokes: DrawesomeStroke[];           // freehand layer (drawesome getStrokes/setStrokes)
  elements: Element[];                  // text, image/icon, rect, line, over or under strokes
  plugins?: string[];                   // data sources this scene uses, e.g. ["crypto"]
};
type Element =
  | { type: "text"; x; y; text: string; size; weight; align }   // text may contain {{crypto.btc}}
  | { type: "image"; x; y; w; h; src }
  | { type: "rect"; x; y; w; h; fill; stroke };
```

Render pipeline (one function used by the editor preview and the server):
`scene + data → SVG string → resvg (rasterize) → threshold/dither to 1-bit → packed bytes / PNG`

SVG is the shared format: drawesome already exports strokes as SVG, and text and images are easy to
express in SVG. On the server, `@resvg/resvg-js` rasterizes in milliseconds with no headless browser.

## Stack

- **Monorepo** (pnpm workspaces), TypeScript everywhere except the Pi client
  - `packages/scene` (`@papershow/scene`): Scene types, `sceneToSvg()`, binding substitution, dithering. Shared by web and server.
  - `apps/web`: Vite + React. ImageGen editor now, SlideGen admin later.
  - `apps/server`: Hono on Node or Bun, SQLite (scenes, slides, schedule, plugin cache), resvg.
  - `apps/showpi`: small Python client, since Waveshare's drivers are Python.

## Phase 1: ImageGen (start here)

1. **Scaffold.** Vite + React + TS. Fixed 800×480 artboard, scaled to fit the screen, with drawesome
   filling it.
2. **Drawing.** Drawesome toolbar: pens, eraser, undo/redo, and black/white swatches as the defaults,
   since the target is 1-bit.
3. **Element layer.** Drawesome only does freehand strokes, but the crypto slide needs text and icons.
   Add an SVG layer for text, image, and rect elements with select/move/resize, plus a small
   inspector (font size, align). Use a tool toggle: Draw mode or Arrange mode.
4. **E-ink preview.** A toggle that shows the artboard through the same threshold/dither the panel
   will get, so you see in the editor what the Pi will show.
5. **Save.**
   - Download PNG/SVG locally (drawesome `download()` covers strokes; the full scene goes through `sceneToSvg`)
   - Save the scene to the server (`POST /api/scenes`) and get a list of saved scenes to reopen
   - Autosave a draft to IndexedDB so a refresh never loses work
6. **Bindings.** Text supports `{{plugin.field}}`. The editor shows sample values from the plugin's
   `sample` data.

**Done when:** you can rebuild the crypto slide (3 icons + 3 bound prices) in the editor, preview it as
1-bit, save it, and reopen it.

## Phase 2: SlideGen

- **Slides:** scene + duration + rules (time-of-day window, weekdays, priority) + an optional "pin now" override.
- **Scheduler:** a pure function `(slides, now) → current slide`. Easy to unit test.
- **Plugins:** in-process TS modules:
  ```ts
  export default { id: "crypto", ttl: 60, sample: {...}, fetch: async () => ({ btc: "$83,785.00", ... }) }
  ```
  Results are cached per TTL. Plugins never run per request.
- **Render cache:** key = hash(scene + data). Render only when the key changes.
- **`GET /live`:** returns the current frame with a strong `ETag` (`If-None-Match` → `304`).
  Formats: `?fmt=png` for humans and `?fmt=raw1bpp` for the Pi (bytes go straight to the panel buffer).
- **`GET /live/wait?etag=…`:** long-poll that returns as soon as the frame changes. The Pi gets updates
  immediately with no polling interval.
- **Admin UI** in `apps/web`: playlist ordering, durations, rules, a live preview of `/live`.

## Phase 3: ShowPi

- One Python script plus a systemd service: long-poll `/live/wait`, then write raw bytes to the EPD
  driver, then put the panel to sleep.
- On network errors, keep the last frame on screen (e-ink holds it at zero power) and back off.
- Do a full refresh every N partial refreshes, if the panel supports partial refresh, to clear ghosting.

## Open questions

- Exact panel model. I assumed the Waveshare 7.5" B/W at 800×480, based on the example image's size.
  This sets the artboard size and the raw byte format.
- Where does SlideGen run: on the Pi itself or on another machine? Both work. Running elsewhere keeps
  the Pi idle.
- Drawesome's license isn't stated on its page. Check it before depending on it.
- Is there existing code from the current setup (plugins, driver code) worth porting?
