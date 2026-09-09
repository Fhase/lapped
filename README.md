# High Park Laps

A Strava companion and Chrome extension that writes `High Park laps: N` into a rider's activity description only when Strava reports one or more completed efforts for the configured High Park segment. If no effort is found, the activity description is not touched.

## Run locally

1. Create a Strava API application and set its authorization callback domain to `localhost` for local development.
2. Copy `.env.example` to `.env`, then add the client ID, secret, a long session secret, and the numeric segment ID from the chosen **High Park Lap** Strava segment URL. The exact segment needs to be selected deliberately because multiple similarly named High Park segments can exist.
3. Install and run: `npm install && npm run dev`.
4. Visit `http://localhost:3000`, connect Strava, then load the unpacked `extension/` directory in Chrome at `chrome://extensions` (Developer mode → Load unpacked).
5. Open one of your Strava activity pages and press the extension's **Count completed laps** button.

## Automatic post-upload counting

For hands-off operation, deploy the app on a public HTTPS URL, set `APP_URL` to that URL, supply `STRAVA_VERIFY_TOKEN`, and register `https://your-domain/webhook` as your Strava webhook callback. Strava will call it after an activity is created or updated; the server acknowledges immediately and then scans the activity for the configured segment. This allows the lap line to appear without opening the extension. The extension remains useful for manually re-scanning an already-uploaded ride.

### Render deployment

`render.yaml` defines a small paid Render web service with a 1 GB persistent disk, which preserves the token store for webhook processing. Render supplies a public `onrender.com` URL automatically and the app uses it for OAuth when `APP_URL` is not set. During the Blueprint setup, enter the Strava client ID and secret as protected environment values. Once deployed, set the Strava app's authorization callback domain to the Render hostname and create its webhook subscription using `https://<your-render-host>/webhook`.

## Important production note

This starter writes connected-athlete tokens to `data/tokens.json` so webhooks can work. Treat that file as sensitive: it is ignored by Git but is not encrypted. For a public service, use HTTPS, encryption at rest, a real session store, and secure secret management. The needed permissions are `activity:read_all` and `activity:write`; the API lets an app fetch an owned activity with all segment efforts and update its description.
