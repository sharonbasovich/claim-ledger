# Supplied test record — PantryPal

Maintainer-supplied output from `pytest` on 2026-09-10 (tag v1.2.0):

    18 passed, 2 skipped, 0 failed in 41.20s

The skipped tests cover the WebRTC sync handshake, which the CI runner cannot
execute headlessly; the maintainer says they were run manually on two laptops.
Barcode lookup is tested against a fixture of 500 products.

No coverage number was supplied. The maintainer notes the expiry-notification
logic is "mostly covered" by the notification tests.
