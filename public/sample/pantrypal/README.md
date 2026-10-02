# PantryPal

PantryPal is a small pantry inventory app that scans product barcodes and
warns before food expires. Scanning uses the device camera through the
BarcodeDetector API, with a fallback to manual entry.

The app sends expiry alerts as local notifications 3 days and 1 day before an
item's date. A shared household list syncs between devices over the local
network using WebRTC data channels; no cloud account is needed.

PantryPal stores everything in a single SQLite file and can export the full
inventory to CSV. It claims a scan-to-shelf time of under 2 seconds per item
on a mid-range phone.
