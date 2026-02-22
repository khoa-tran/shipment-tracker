# ONE Carrier Integration Rewrite

## Problem

The current `one.ts` uses CDP with `responseUrlMatch: 'cargo-tracking'`, but the ONE website uses REST API endpoints under `/api/v1/edh/` that don't match this pattern. The code also sends the full tracking number (with ONEY prefix) which the website rejects.

## Approach

Direct HTTP + JSON API. No BrowserWindow needed. Simplest pattern, matching Evergreen's approach but with REST APIs instead of HTML scraping.

## API Endpoints

| Endpoint | Method | Returns |
|---|---|---|
| `ecomm.one-line.com/api/v1/edh/vessel/track-and-trace/voyage-list?booking_no=X` | GET | Vessel legs with POL/POD/dates, container references |
| `ecomm.one-line.com/api/v1/edh/containers/track-and-trace/cop-events?booking_no=X&container_no=Y` | GET | Event timeline per container |

## Input Handling

Strip `ONEY` prefix: `ONEYTAOFQ2415500` -> `TAOFQ2415500`.

## Field Mapping

**From voyage-list:**
- `vesselEngName` -> vessel name
- `pol.locationName` / `pod.locationName` -> port of loading/discharge
- Last leg `pod.arrivalDate` -> ETA
- Response also provides schedule/voyage numbers

**From cop-events:**
- `eventName` -> event description
- `eventLocalPortDate` -> event date
- `location.locationName + countryName` -> location
- `yard.yardName` -> terminal

## Changes

1. Rewrite `src/main/carriers/one.ts` - replace CDP with direct HTTP
2. Uncomment `import './one'` in `src/main/carriers/index.ts`

## Error Handling

- 30s timeout
- Return `null` on any failure
- `dumpDebug` for dev-mode logging
