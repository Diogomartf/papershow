# Working on Papershow

Read [README.md](README.md) first for how the pieces fit. This file covers the day-to-day: commands, conventions, and how to build an app for the e-ink panel.

## Commands

```sh
pnpm dev                                   # web :5193 + server :5194, both reload on save
cd apps/server && pnpm typecheck           # server types
cd apps/web && npx tsc -b && pnpm lint     # web types + oxlint
PANEL_OUT=/tmp/panel.png python3 apps/panel/panel.py   # the panel client, drawing to a PNG
```

On the Pi:

```sh
paper:status                               # services, version, addresses, keys, last frame
paper:logs [server|panel|update]           # follow the logs
paper:update                               # get the latest release and reinstall (the Pi also does it nightly)
paper:channel [main|releases]              # what updates follow: every commit on main (dev), or releases
paper:help                                 # list these commands
```

There are no unit tests yet. Check your work by rendering frames and looking at them (see [Check it](#4-check-it)).

## Conventions

- TypeScript everywhere, ESM, no build step on the server (`tsx` runs it).
- Comments explain *why*, in plain sentences, at the density of the surrounding code. Doc comments go on exported things and anything non-obvious.
- Server code reads `process.env` when it needs a value, not at import time: `.env` is loaded after modules are imported.
- Secrets go in `.env` at the repo root, never in code. Document every new key in `.env.example` and in the README's Configuration table.
- When you add or change an app, update the README's apps table: data source, key, refresh.
- **People.** Everything under `/api` needs someone signed in (the middleware in `index.ts`); only `/api/hello…` is open, and `/live` never needs anyone. A route that changes a drawing, app or playlist checks `mayChange(c, row.madeBy)`; admin-only settings check `isAdmin(c)`. Guests can read anything but the log and change only what's in `GUEST_MAY`: a new route is closed to them until you add it there. A route that puts something on the panel or adds something new spends a go with `tooMany(c, "live" | "make")` (admins have no limit; the allowances are `LIMITS` in `people.ts`). Anything people would want to see in the log gets a `note(c, verb, { item: named(src) })`, and a sentence for the verb in `says()` in `apps/web/src/house.ts`.

## The panel and the Pi

`apps/panel/panel.py` drives the e-ink panel; `deploy/pi/` installs the server and the client on a Raspberry Pi 5. The README's [On a Raspberry Pi](README.md#on-a-raspberry-pi) section covers using them; this covers changing them.

- **The client knows only the contract.** It follows [The panel's contract](README.md#the-panels-contract) and nothing else, so it can follow any server. Anything the panel needs to know (night, what changed, when) goes in `/live`'s headers, not in client settings. If you change the contract, change the client in the same commit.
- **Keep the client small.** Python standard library plus Pillow, which comes from apt on the Pi. No pip installs: Waveshare's pip package pulls in `RPi.GPIO`, which doesn't work on a Pi 5.
- **Don't update `apps/panel/waveshare_epd`.** It's the copy known to work on this panel. Upstream changed the panel voltages since. Replace it only after trying the new one on the real panel.
- **Refreshes cost flashes.** Full refreshes for a new source, partials for the same source, a deep clean once a day as night begins. Don't add redraws the server didn't ask for.
- **Check client changes** with `PANEL_OUT`, against `pnpm dev` and with the server stopped. You can't run the real panel off the Pi, so say in the PR what still needs a test on it.
- **The splash** (`apps/panel/splash.png`) is rendered by `apps/server/src/splash.tsx`. Run `npx tsx src/splash.tsx` in `apps/server` after changing the logo, and commit the PNG.
- **`install.sh` is also the one-line install.** Piped into `bash` (README step 2), it clones or updates `~/papershow` and runs the checkout's copy with `exec`. Until that `exec`, bash is still reading the script from stdin, so every command there takes `</dev/null`. Prompts (Tailscale) read from `/dev/tty`, and are skipped when there's none. Keep the one line in the README, the PR and the script's header comment the same.
- **pnpm is pinned to 7**, the version that wrote `pnpm-lock.yaml`; newer ones refuse it. The install runs it through `npx pnpm@7`. Upgrading pnpm means regenerating the lockfile and changing both.
- **`install.sh` runs on Pis that are also used for other things.** Keep it safe to rerun, and don't take over what's already there: ports, Tailscale serve, cron, the system Node. Check and warn, or stop with a clear message. The units in `deploy/pi/*.service` are templates: `@USER@`, `@REPO@` and `@PORT@` are filled in on install, and personal settings go in `systemctl edit` drop-ins, which survive reinstalls.
- **`uninstall.sh` undoes what `install.sh` adds**, and nothing more. When the install gains a step (a unit, a file, a Tailscale route), add its undo. Data is deleted only with `--purge`, and shared things (Node, apt packages, SPI, Tailscale itself) stay.
- **Pis follow releases, not `main`.** The one-line install leaves the checkout on the latest `vX.Y.Z` tag (detached), and `paper:update` moves it to the next one; a checkout on a branch follows the branch instead (`paper:channel main`, or `PAPERSHOW_BRANCH=main` on install). Merging to `main` reaches no one's wall until you release. To release, from an up-to-date `main`: `gh release create v0.3.0 --target main --notes …`. Tags are never moved or deleted once out, and `-rc1` and other pre-release tags are skipped by Pis.
- **Picking the number.** Before 1.0, from v0.2.0: anything new (a command, an app, a setting) is the next minor, v0.3.0; only fixes is the next patch, v0.2.1. A release with both is a minor. 1.0 waits until someone else has installed it on a fresh Pi and a few releases have gone out without breaking the database, `/live` or the install; after it, a breaking change means 2.0. Release notes lead with what's new for someone with the panel, the commands to try it, and end with the compare link (`…/compare/v0.2.0...v0.3.0`).
- **`deploy/pi/paper.sh` is the `paper:` commands** (`paper:update`, `paper:channel`, `paper:status`, `paper:logs`, `paper:help`); the name it's called by picks the command. A new one needs its name in the lists in `install.sh` and `uninstall.sh` and a row in the README's Commands on the Pi table.
- New client settings are environment variables: document them in `panel.py`'s docstring and in the README's Panel settings table.

## Building an e-ink app

An app is one file in `apps/server/src/apps/` that turns data into an 800×480 black-and-white frame. The server calls `data()`, passes the result to `view()`, renders the JSX with satori and resvg, and reduces it to 1 bit. You never touch pixels unless you're placing a photo.

### 1. Write the file

```tsx
// apps/server/src/apps/weather.tsx
import { defineApp, sheet } from "./types.ts";

export default defineApp({
  kind: "weather",                    // unique and stable: saved instances refer to it
  name: "Weather",
  category: "news",                   // "clock" | "ai" | "news" | "markets": where it's listed under New app
  description: "Today's forecast for one city.",
  source: "Open-Meteo",               // shown in the app's settings as "from Open-Meteo"
  defaults: { city: "Lisbon", metric: true },
  fields: [
    { key: "city", label: "City", type: "text", placeholder: "Lisbon" },
    { key: "metric", label: "Celsius", type: "toggle" },
  ],
  periodMs: 15 * 60_000,              // at most one new frame per 15 minutes, aligned to the clock
  mock: false,
  data: async (config, now) => {
    const res = await fetch(`https://…?q=${encodeURIComponent(config.city)}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`weather → ${res.status}`);
    return (await res.json()) as { temp: number; summary: string };
  },
  view: ({ config, data }) => (
    <div style={{ ...sheet, flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <span style={{ fontSize: 200, fontWeight: 300 }}>{`${Math.round(data.temp)}°`}</span>
      <span style={{ fontSize: 40 }}>{data.summary}</span>
    </div>
  ),
});
```

### 2. Register it

Import it in `apps/server/src/apps/index.ts` and add it to the `APPS` list, next to its category. It then appears on the Apps page with a form built from `fields`, a live preview, Duplicate, and it can go in playlists and the show. No web changes needed.

### The definition, field by field

| Field | Notes |
|---|---|
| `kind` | Stored on every instance. Never rename one that's in use. |
| `category`, `source`, `description` | What the Apps page shows. `source` names where the data comes from. |
| `defaults`, `fields` | Every setting needs both: `configFor` drops keys not in `fields` and fills gaps from `defaults`. |
| `periodMs` | How often the frame can change. Renders are cached per period. |
| `periodFor(config)` | Optional: let a setting choose the period (the AI apps' "New text"). |
| `clipS` | Optional: how long it stays on air when added (default 15 min; clocks use 60 s). |
| `mock` | True while the app shows stand-in data. Use a getter when it depends on a key: `get mock() { return !process.env.MY_KEY; }` |
| `dither` | How the whole frame becomes 1 bit. Leave it at `"threshold"` (the default) for text and shapes. See [Pictures](#pictures). |
| `data(config, now)` | Fetches and shapes data. Sync or async. |
| `view({ config, data, now })` | Returns the frame as JSX. Pure, no fetching. |

`defaults`, `fields` and `mock` can be getters when they change at runtime. The AI apps' model list does this.

### Setting types

| `type` | Form control | Value in `config` |
|---|---|---|
| `text` | One-line input | trimmed string |
| `textarea` | Multi-line input (prompts) | trimmed string |
| `toggle` | Switch | boolean |
| `select` | Row of buttons, wraps when long | one of `options[].value`; anything else falls back to the default |
| `list` | Comma-separated input | lowercased string array |
| `picks` | Tap to pick several of `options`, in order, up to `max` | string array, only known values |

Write empty array defaults as `[] as string[]` so the type isn't `never[]`.

### Data: rules that keep the panel up

- **Use `now`, not `Date.now()`.** `now` is the start of the period, so every request in it and the dashboard's look-ahead agree.
- **Time out every fetch**: `signal: AbortSignal.timeout(10_000)`.
- **Keep the last good result.** Store it in a module-level `Map` keyed by the settings that matter. When a fetch fails, return it; throw only if there's nothing yet. A blip should never blank the panel.
- **Share calls.** Several instances, the live panel and the settings preview all render the same app. Cache upstream responses (crypto shares one CoinGecko call for a minute; `complete()` in `apps/server/src/ai.ts` asks Groq once per prompt per period). Mind free-tier rate limits.
- **Without a key, show stand-in content** and report `mock: true`. The app must still render so its layout can be designed. Read keys from `process.env` inside functions.
- **Things that never change** (logos, company names, past closing prices) are fetched once and kept.
- **Model text**: use `complete(prompt, now, model)` from `apps/server/src/ai.ts`. To build a prompt-driven app, add a preset with `promptApp()` in `apps/server/src/apps/ai.tsx` instead of writing a new file.

### View: how satori draws

satori is not a browser. It handles a subset of CSS, inline only.

- Spread `sheet` on the root. It sets 800×480, white, black, Inter, `border-box`. Without `border-box`, padding grows the sheet past the panel.
- **Every `div` with more than one child needs `display: "flex"`.** Most layout errors come from this.
- Styles are inline objects. No class names, no stylesheets, no `grid`.
- Rules and spacers in a column need `flexShrink: 0`, or they get squeezed to nothing when text runs long.
- Fonts: **Inter** 300–700, **Source Serif** 400/600/700 (`fontFamily: "Source Serif"`), **Blackletter** 400 (mastheads). Add others in `apps/server/src/render.ts`.
- Images: `<img src={dataUrl} width={…} height={…} />`. Remote URLs work but are slow and uncached; embed data URLs.
- Size text by length: pick the font size from `text.length` so short and long replies both fill the space (see `fit()` in `ai.tsx`). Check the longest realistic value.

### Designing for 1-bit e-ink

The panel shows black or white, nothing else. Design for that rather than hoping the reduction saves you.

- **No greys and no colours** in text, rules or shapes. With `threshold`, anything lighter than mid-grey vanishes and anything darker turns solid black. Use weight, size and space for hierarchy, not tint.
- **Big type.** People read it across a room: headlines 40–100 px, body 18 px or more, small print 12 px at the least.
- **Lines at least 1 px, ideally 2.** Hairlines and thin serifs break up. Inter 300 works at display sizes (the clock), not for small text.
- **High contrast and lots of white.** Margins of 32–64 px, a clear focal point, at most two or three type sizes.
- **No animation, no seconds.** A frame lasts a whole period, and a refresh flashes the panel. Show minutes, not seconds, and nothing that implies motion.
- **Only change when the content does.** The frame hash decides whether the panel redraws, so don't render anything that differs on every request (random numbers, `Date.now()`).
- Reuse the shared marks in `marks.tsx` (`Badge`, `Trend`, `TokenMark`) for tickers and arrows.

### Pictures

Photos and logos need dithering, which turns tones into a pattern of black and white dots. Dithering the whole frame roughens every letter, so don't set `dither: "atkinson"` on the app. Dither each picture on its own at its final size:

```ts
import { ditheredImage } from "../render.ts";

const src = ditheredImage(bytes, 330, 330, { type: "image/jpeg" });   // data URL, already 1-bit
// round logos: ditheredImage(png, 110, 110, { round: true })
// rounded squares: ditheredImage(png, 104, 104, { radius: 23 })
```

It crops to fill the box, tunes the picture for e-ink with `enhance()` from `@papershow/scene` (levels stretch, S-curve contrast, unsharp mask; adjustable with `{ levels, contrast, sharpen }`), and Atkinson-dithers it. Give the `<img>` the same width and height, and leave the app's `dither` at `"threshold"`.

In the Apps page's **Original** view, `ditheredImage` returns the picture in full colour at 2× instead. If you cache its result, include `isOriginal()` from `render.ts` in the cache key, as `crypto.tsx` does.

### 4. Check it

Render frames and look at them. Do this for the default settings, the longest realistic text, and with no key:

```ts
// apps/server/src/_try.ts: run with `npx tsx src/_try.ts`, then delete it
import { writeFileSync } from "node:fs";
process.loadEnvFile("../../.env");                     // only if the app needs keys
const { previewFrame } = await import("./apps/index.ts");
writeFileSync("/tmp/weather.png", (await previewFrame("weather", { city: "Porto" })).mono);
writeFileSync("/tmp/weather-original.png", (await previewFrame("weather", {}, { original: true })).png);
process.exit(0);
```

Or, with `pnpm dev` running, open the app on the Apps page and switch between E-ink and Original. Then run the typecheck for both packages.

Before you're done:
- [ ] Renders with default settings, long text, and no key (stand-in plus `mock: true`).
- [ ] Nothing on the frame depends on anything finer than the period.
- [ ] Fetches time out, failures fall back to the last result, upstream calls are shared.
- [ ] Text is black, big enough, and fits. Pictures go through `ditheredImage`.
- [ ] Registered in `APPS`, with the right `category` and `source`; README apps table updated; new keys in `.env.example`.
