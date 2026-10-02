# TrailMend known limitations

Offline mode covers viewing and following a downloaded route only. Route
planning and GPX import are not available offline because they need the tile
index, which is fetched on first load.

Elevation data currently covers Europe and North America. Routes outside
those regions show a flat profile rather than an error.

The PDF export uses the browser print pipeline; on Android it produces a
blank second page when the trip has more than 12 waypoints. Naismith timing
does not account for scree, snow, or via ferrata sections.
