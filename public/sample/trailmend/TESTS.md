# Supplied test record — TrailMend

Maintainer-supplied output from `npm test` on 2026-09-14 (commit 8f3a2c1):

    Tests:  12 passed, 2 failed, 14 total
    Suites: 4 passed, 1 failed, 5 total

The two failing cases are `gpx-import-douglas-peucker` (tolerance drift after
the simplifier upgrade) and `tile-cache-eviction` (timing-sensitive, passes in
isolation). The maintainer notes both are tracked in issue 41.

Coverage is reported as 71% lines. The elevation smoke test was run manually
and produced a profile within 40 m of the survey waypoint at Rifugio Lavaredo.
