# TrailMend

TrailMend is a progressive web app for planning day hikes on marked trails.
It works offline once trail tiles are downloaded, so hikers can check their
route without a data connection. The app imports GPX files and renders an
elevation profile for any loaded route.

The route planner suggests loops between 5 km and 40 km and estimates hiking
time with Naismith's rule adjusted for steepness. Map tiles are vector tiles
served from a local directory; no external tile service is required at runtime.

TrailMend supports exporting a trip summary as a shareable PDF. It is free and
open source under the MIT license. The current release is v0.9.3.
