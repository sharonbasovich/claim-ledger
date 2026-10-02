# PantryPal known limitations

Barcode recognition only covers products in the Open Food Facts subset, which
is strongest for US and EU packaged goods; fresh produce and regional brands
often resolve to "unknown product" and need manual naming.

Local-network sync requires both devices on the same Wi-Fi segment and does
not traverse NAT. There is no conflict resolution: the last writer wins.

Camera scanning needs a secure context, so the app cannot scan when served
over plain HTTP on a LAN IP. Notifications on iOS require the app to be
installed to the home screen first.
