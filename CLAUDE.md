# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Shipment Tracker is a cross-platform Electron desktop app for tracking shipments from Evergreen and MSC shipping carriers. Built with TypeScript, esbuild, and cheerio for HTML parsing.

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
  index.html              ├── carriers/detect.ts
  styles.css              ├── carriers/evergreen.ts
                          └── carriers/msc.ts
```

- **Preload script** (`preload.ts`) bridges renderer↔main via `contextBridge`, exposing only `electronAPI.trackShipment()`
- **Context isolation** is enabled; sandbox is disabled (required for MSC's Chrome DevTools Protocol scraping)

### Carrier Tracking Strategies

**Evergreen** (`evergreen.ts`): HTTP POST to `ct.shipmentlink.com` + cheerio HTML parsing. Supports B/L, container, and booking searches. 30s timeout.

**MSC** (`msc.ts`): Headless BrowserWindow with Chrome DevTools Protocol. Intercepts network responses from the TrackingInfo API endpoint. 45s timeout.

**Carrier detection** (`detect.ts`): Identifies carrier and search type by prefix patterns (e.g., EISU/EGHU → Evergreen container, MSCU/MEDU → MSC container, 12-digit numeric → Evergreen B/L).

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
