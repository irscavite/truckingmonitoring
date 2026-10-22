# ENLIN Movement — single-page dashboard

This version replaces the former ENLIN + BACAO combined/dashboard/report screens with **one ENLIN dashboard**. All screenshot/mockup sections, BACAO sections, the weather block, and the separate report tab were removed. It is a read-only dashboard; it does not write to Firebase.

## What the counters mean

- **Truck IN:** number of movement records in `daily_movements/YYYY-MM-DD` for the current Philippine day (all trucks, not only trucks carrying an empty container).
- **Truck OUT:** records with an OUT timestamp today, even if their IN was on an earlier day. The dashboard loads IN-date buckets for today, yesterday, and the previous 30 days.
- **Truck Remaining Inside:** current active trucks in `active_trucks`, including those that entered on earlier dates. This is not computed using today's IN minus today's OUT.
- **Pass Through:** unchanged from the prior app: records in today's IN bucket marked `passThrough: true` or `movementType: "PASS THROUGH"`.
- **Hourly chart:** 3 bars for each hour in Philippine time (00:00–23:00). Blue is IN, green is OUT, purple is **estimated end-of-hour inside**. The IN/OUT bars use the left scale; the Inside bars use a separately labeled right scale. The inside history is reconstructed from current active truck count and today's IN/OUT events.
- **Average dwell time:** average `timeOut - timeIn` for records **exiting today** that have both valid timestamps; transactions without valid IN/OUT values are excluded. The number of records used appears under the average.
- **Truck turnaround time distribution:** the five bars under Average Dwell Time classify the same completed truck exits today used by the dwell-time average: **0–10 minutes (inclusive), over 10–20 minutes, over 20–40 minutes, over 40–60 minutes, and over 60 minutes**. All five ranges are mutually exclusive and total exactly the number of valid completed trucks. The counts, share percentages, total, and data-sync timestamp are shown. An OUT record with missing or invalid timestamps is excluded; such records are noted beneath the chart when detectable. The displayed category names are operational shorthand; the precise boundaries avoid double-counting at 10/20/40/60 minutes. This section follows the same 30-day IN-date history limitation as OUT and dwell time.
- **As of:** the date/time of the most recent successful data sync (Philippine time), not a clock pretending failed requests are up to date.

## Data sources

The existing ENLIN Firebase Realtime Database URL is kept in `app.js`:

- `daily_movements` (stored by IN date)
- `active_trucks` (current inside trucks)

The dashboard listens for live changes to today's and yesterday's movements and to `active_trucks`; it periodically checks connection and reloads the older history in the background. When an older active truck is removed, it also attempts to reload the truck's original IN-date bucket.

**Accuracy limitation:** Firebase stores `daily_movements` by IN date, not OUT date. OUT totals and average dwell time can omit departures whose original IN was over 30 days ago (unless that older bucket was loaded after the active truck left). The correct long-term solution is to update the truck input app to maintain a date-indexed `daily_exits/YYYY-MM-DD` aggregate/index at OUT time, so older exits can be counted without scanning months of history. No changes to the truck input app are included in this ZIP. If the Firebase read rules block history, the dashboard shows a warning and uses accessible records rather than inventing totals.

## Run / publish

Open `index.html` from a local HTTP server (e.g. Python `python -m http.server 8000` in the project folder), or upload these static files to your existing static hosting/GitHub Pages. No build step or third-party chart library is needed. Your Firebase Realtime Database security rules must permit the dashboard's read requests; do not publish admin credentials in the code.
