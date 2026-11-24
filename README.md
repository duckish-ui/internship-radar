# Internship Radar

A live dashboard that pulls internship listings from three sources and flags new ones as they appear.

| Source | What's pulled |
|---|---|
| [Simplify Summer 2027](https://github.com/SimplifyJobs/Summer2027-Internships) | Active listings with the "Summer 2027" term |
| [Vansh Summer 2027](https://github.com/vanshb03/Summer2027-Internships) | All active listings |
| [empluzzed (software)](https://empluzzed.fyi/internships?role=software) | Same filter as `?role=software`: software, AI/ML, and cloud roles |

## Run

Needs Node 18 or newer. No `npm install` step.

```
node server.js
```

Then open http://localhost:3000.

- The server checks all three sources every 5 minutes. To change that, set `POLL_MINUTES` (PowerShell: `$env:POLL_MINUTES=2; node server.js`).
- Listings found after the first run are marked **NEW**. Open pages update live, show a pop-up, and send a desktop notification once you click **Enable alerts**.
- **Mark all seen** clears the NEW badges. **Check now** runs a check right away.
- `data/state.json` stores what has already been seen. Delete it to start over.

The server only checks while it's running, so keep the terminal open.
