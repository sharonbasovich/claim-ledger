# PantryPal setup

Python 3.11+ required. Install with `pip install pantrypal[web]`.

Set `PANTRYPAL_DB` to the path of the SQLite inventory file (default
`~/pantrypal.db`). First run creates the schema and downloads the Open Food
Facts barcode subset, about 180 MB.

Run the web UI with `pantrypal serve`; it binds to port 8080. Camera access
requires the page to be served over HTTPS or on localhost. Pairing a second
device prints a QR code in the terminal.
