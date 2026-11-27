# Map & Posters Context

Offline-first standalone desktop web editor (`index.html`) for turning GPX trip recordings, stops, and photos into printable and shareable trip posters. All user files, edits, and exports stay local to the browser.

## Language

**Project**:
The complete editable trip workspace persisted locally in IndexedDB and exported via a version 1 Backup (`format: "map-and-posters", version: 1`), containing Recordings, Days, Places, Visits, Photos, Sources, and Output settings. Strictly excludes third-party API keys or device-local credentials.
_Avoid_: Session state, cloud document, raw export bundle

**Recording**:
An imported GPX file stored with its parsed Track (`Point[][]`), raw XML, filename, import sequence, and `included` flag. Excluding or reordering a Recording never destroys its source geometry.
_Avoid_: Raw GPX string, track segment, day route

**Range**:
A contiguous slice (`recordingId`, `segment`, `start`, `end`) indexing into a Recording's Track. One or more Ranges define the recorded geometry of a riding Day.
_Avoid_: Track slice copy, coordinate array, waypoint span

**Day**:
A numbered itinerary slot in a Project — either a riding day backed by one or more Ranges, or a **Rest Day** (`rest: true`, empty Ranges) — with an editable name, route colour, and optional ISO date.
_Avoid_: Stage, leg, calendar entry

**Boundary**:
A `PointRef` (`recordingId`, `segment`, `point`) splitting a riding Day into two consecutive Days. Adjacent Days share the Boundary point so total trip distance is preserved without artificial gaps.
_Avoid_: Cut index, split marker copy, detached endpoint

**Pass**:
A distinct spatial visit of a recorded route through a clicked map neighborhood or Place, produced after collapsing GPS jitter and switchback micro-oscillations within one continuous visit into a single best sample.
_Avoid_: Raw local minimum, noisy micro-hit, duplicate track point

**Place**:
A named geographic location (`lat`, `lon`, `category`, `visible`) created from GPX waypoints, photo EXIF GPS, coordinates/map links, or optional place lookup, which can be plotted on posters and exported to GPX.
_Avoid_: Pin copy, map marker, raw waypoint

**Visit**:
A link between a Place and a specific Day, optionally marked `overnight` and anchored to a track `PointRef` when a route passes through the same Place more than once.
_Avoid_: Stop tag, overnight flag on Place, unlabeled pin

**Photo**:
A JPEG or PNG trip image storing both a display-sized data URL (`src`) and its original bytes (`original`), assigned to either the Full trip (`dayId: ""`) or a specific Day, with optional `hero` (lead) flag, crop/zoom framing, and EXIF GPS coordinates.
_Avoid_: Thumbnail blob, gallery attachment, untyped media

**Poster Target**:
A renderable poster view derived from a Project — the Full trip (`trip`), a single Day (`day:<id>`), or a multi-day Group (`group:<id>`) — each maintaining independent label positions and place visibility.
_Avoid_: Export canvas, static image, layout preset

**Guided Wizard**:
The centered modal `<dialog>` workflow (Steps 1–5) guiding users from GPX import through day splitting, stop selection, photo assignment, and poster download while staying live-synced with the Full Editor.
_Avoid_: Onboarding overlay, detached form, separate app mode

**Backup**:
A self-contained version 1 JSON snapshot of the Project (including original GPX Sources and Photos) downloaded for browser portability and disaster recovery.
_Avoid_: Partial settings dump, unversioned export, localStorage snapshot
