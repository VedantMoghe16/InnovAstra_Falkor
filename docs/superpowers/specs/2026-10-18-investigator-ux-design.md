# RUDRA UX redesign - investigator-first (2026-10-18)

## Why
The user (product owner) found the UI overwhelming: too much on screen at equal volume. Features are good; presentation
is the problem. Goal: someone opening RUDRA for the first time (a judge, a new investigator) understands it within a
minute, and a daily investigator can use it comfortably for hours. Keep the current colour palette - the user likes it.

## Who and the day
An AML investigator at an Indian public-sector bank. Their day: (1) see what needs me, (2) open one item,
(3) get a clear answer with evidence one click away, (4) approve / reject / act, (5) move on. Supervisors additionally
approve agent proposals. Everything else (models, geo, analytics, settings) is occasional.

## Design principles (apply everywhere)
1. **Answer first.** Lead each screen with the one thing the user must know or do; details below or behind a click.
2. **One primary action per area.** Exactly one dark (`Button variant="primary"`) button per card/region.
3. **Progressive disclosure.** Cypher, raw JSON, tool arguments, timings: behind `Disclosure` ("Show query").
4. **Plain language.** Say what it means to an investigator ("Follows the money from A to where it lands"),
   not internal names (`trace_funds`). Internal names may appear small and grey as secondary text.
5. **Calm density.** Max ~3 visually loud things per screen. Prefer whitespace, fewer borders, smaller grey secondary text.
6. **Teach in empty states.** Every empty area says what will appear there and how to make it appear.
7. **ASCII only** in all UI text (no arrows/dashes/dots/rupee glyphs - use "->", "-", "|", "Rs" / "USD").
8. Use the shared primitives in `frontend/src/components/ui.jsx` (`Card, SectionHeader, Button, Pill, Stat,
   EmptyState, Tabs, Disclosure`) and `frontend/src/format.js` (`formatUsd`). Do not invent new colour values;
   accents are lime `#a6d65c`, yellow `#f2c94c`, orange `#e8743b`, ink `#161814` (Tailwind `bg-lime`, `text-ink` exist).

## Screens
### A. "Today" home (new, route `/`)
- Greeting line + one-sentence explanation of what RUDRA does (first-run understanding).
- **Needs your decision**: agent proposals awaiting a supervisor (action, why, investigation, age) with Approve / Reject
  inline for SUPERVISOR/ADMIN, "Open" for others. Empty state explains that proposals appear after investigations.
- **Start an investigation**: top 5 open incidents by USD-equivalent flow (pattern, severity, accounts) each with one
  "Investigate" button -> `/investigator?q=Investigate incident INC-xxxx`.
- **Recent investigations**: last 5 with verdict pill; click opens it in the Investigator.
- Slim stat row (4 numbers max): open incidents, pending decisions, investigations this week, graph size.
- First-visit "How RUDRA works" 3-step strip (Ask -> Agent follows the money -> You decide), dismissible
  (remember in localStorage, wrapped in try/catch).
- The old Dashboard stays reachable at `/overview`.

### B. Investigator page (`/investigator`) - restructure, keep all features
Layout top to bottom:
1. **Ask bar** (one input + primary "Investigate"), 3 suggestion chips, and a small "Options" disclosure holding
   brain selector + graph-tools toggle + "Run without graph tools" (removal test).
2. **Result first**: when a verdict exists, the Verdict card is the first thing under the ask bar, full width:
   big verdict, confidence bar, one-sentence grounding ("Backed by N graph findings and M verified transactions"),
   summary, then "Proposed actions" with Approve/Reject. Findings listed compactly with provenance pills.
3. **How it got there** card with Tabs: `Steps` (plain-language timeline grouped into phases - Orient, Follow the
   money, Check memory, Decide - each step one line; tool name + query + rows + ms inside Disclosure),
   `Money trail` (EvidenceGraph), `Decision trail` (DecisionTrail).
4. While running: progress card showing current phase + live step lines; result card replaces it on completion.
5. Removal-test comparison and investigation memory move to a secondary row / collapsed section at the bottom.
6. Remove the 4 big headline tiles from this page (they live on Today); keep one slim status line.

### C. Navigation (App.jsx)
Sidebar groups: **Work** (Today `/`, Investigator, Cases, Incidents), **Explore** (Network graph, Fund journey,
Collusion rings, Entities, Patterns, Temporal replay), **Insights** (Overview `/overview`, Channel/branch, Geo map,
ML models), **Tools** (Live stream, Simulation, Copilot, SAR reports, Account aggregator, Settings). Explore/Insights/Tools
collapsible, collapsed by default except the group containing the active route.

## Non-goals
No new backend features beyond the read endpoint the Today page needs. No palette change. No removal of pages.
