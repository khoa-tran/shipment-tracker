# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Shipment Tracker is a cross-platform Electron desktop app for tracking shipments across multiple shipping carriers. Built with TypeScript, esbuild, and cheerio for HTML parsing.

## Commands

```bash
npm run build          # Compile TypeScript via esbuild (outputs to dist/)
npm run dev            # Build + launch Electron app
npm run dist:mac       # Build + package macOS DMG installer (outputs to release/)
npm run dist:win       # Build + package Windows NSIS installer (outputs to release/)
```

No test framework or linter is configured.

## Architecture

### Electron Process Model

```
Renderer (src/renderer/)          Main (src/main/)
  renderer.ts  ──IPC──►  ipc-handlers.ts
  index.html              ├── carriers/registry.ts
  styles.css              ├── carriers/helpers.ts (cdpTrack, dumpDebug)
                          ├── carriers/evergreen.ts
                          ├── carriers/msc.ts
                          ├── carriers/hmm.ts
                          ├── carriers/zim.ts
                          ├── carriers/oocl.ts
                          ├── carriers/cosco.ts
                          ├── carriers/one.ts
                          ├── carriers/yangming.ts
                          ├── carriers/kmtc.ts
                          ├── carriers/sealead.ts
                          ├── carriers/cmacgm.ts
                          └── carriers/maersk.ts
```

All carriers self-register via `registry.register()` when imported in `carriers/index.ts`. The registry runs all carriers in parallel; first successful result wins.

- **Preload script** (`preload.ts`) bridges renderer↔main via `contextBridge`, exposing only `electronAPI.trackShipment()`
- **Context isolation** is enabled; sandbox is disabled (required for MSC's Chrome DevTools Protocol scraping)

### Carrier Tracking Strategies

There are six proven integration patterns, chosen based on how each carrier's website serves data and what bot protection it uses:

| Pattern | When to use | Example carriers |
|---------|------------|-----------------|
| **HTTP + cheerio** | Carrier has a simple form POST returning HTML | Evergreen |
| **Direct REST API** | Carrier has an open JSON API, no browser needed | ONE, Yang Ming |
| **CDP network intercept** (`cdpTrack` helper) | Carrier loads data via XHR/fetch returning JSON | MSC, HMM, Hapag-Lloyd, Maersk |
| **Session cookies + API** | Carrier has a JSON API behind bot protection (Akamai, etc.) | ZIM, KMTC |
| **BrowserWindow + DOM scraping** | JS-rendered SPA requiring browser interaction + DOM reads | COSCO, CMA CGM |
| **BrowserWindow + CAPTCHA overlay** | Carrier requires user CAPTCHA solving | OOCL |

**Adding a new carrier**: Check the carrier's website — use Network tab to find API endpoints. Prefer direct REST API (simplest, no browser) or HTTP+cheerio. Use CDP intercept for JS-rendered pages with XHR data. If bot protection blocks Electron, try the session-cookie+API pattern (ZIM/KMTC). Use BrowserWindow+DOM scraping for SPAs without interceptable APIs. Use CAPTCHA overlay only as last resort. Read an existing carrier using the same pattern as a reference.

**Carrier detection**: No prefix-based detection; the registry runs all enabled carriers in parallel and returns the first successful result. OOCL is deferred (runs last) since it may require CAPTCHA.

**Debug logging**: `dumpDebug()` writes response data to `userData/debug/`. Enabled automatically during `npm run dev` or when `SHIPMENT_DEBUG=1` env var is set. Off in production.

### Renderer State Management

The renderer (`renderer.ts`) manages a `TrackedShipment[]` array with:
- **Deduplication**: Matches by shipment ID or overlapping container numbers
- **Merging**: When duplicates found, prefers the richer result and unions container/event data
- **Sorting**: By ETA date, then by insertion order

### Key Types

All carrier data types are defined in `src/main/carriers/types.ts`: `TrackingResult`, `ContainerInfo`, `TrackingEvent`, `PlanMove`.

### Build System

esbuild bundles two entry points:
- **Main process**: CommonJS targeting Node 20 (`main.ts`, `preload.ts`)
- **Renderer process**: IIFE targeting Chrome 130 (`renderer.ts`)

Static files (`index.html`, `styles.css`) are copied to `dist/` by the build script.
