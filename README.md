# lapped

[lapped.fit](https://lapped.fit) is a Strava companion built around High Park in Toronto. Its main feature counts completed laps on the High Park segment and adds a compact receipt to the ride description. The site also includes a transparent ride-overlay studio and a browser-based indoor cycling trainer.

## High Park lap counter

Connect Strava once. When a ride is uploaded, Strava notifies lapped, which checks the ride for completed efforts on the configured High Park segment. If it finds laps, lapped adds its receipt while preserving the rider’s existing description. Rides without a completed target lap are left alone.

```text
laps · 14
fastest lap · 2:38 · 42.3 km/h
www.lapped.fit
```

The segment ID is configurable with `HIGH_PARK_SEGMENT_ID`. lapped processes each rider’s own activities; it does not publish cross-athlete rankings.

## Ride overlays

The [overlay studio](https://lapped.fit/overlay) turns a ride’s lap details into a transparent image to share over a photo. Choose a recent ride or paste its Strava link, pick a layout and image ratio, then save or share the PNG.

## Indoor trainer

The [indoor trainer](https://lapped.fit/trainer/) provides structured workouts in the browser. It can connect to Bluetooth FTMS smart trainers, power meters, cadence sensors, and heart-rate straps. Compatible smart trainers can follow workout targets with ERG control. FTP tests estimate and update FTP, and Strava upload is available for completed rides.

The trainer uses Web Bluetooth, so it needs a supported browser and a secure connection such as the live HTTPS site. Bluetooth access and ERG control depend on the connected device.

## Optional Chrome extension

The `extension/` folder contains an optional Chrome extension for manually rescanning an existing Strava activity.

## Run locally

Use Node.js 22 and npm. Create a Strava API application, set its local authorization callback domain to `localhost`, then configure the environment:

```sh
cp .env.example .env
npm ci
npm run dev
```

Set these values in `.env`:

```text
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
HIGH_PARK_SEGMENT_ID=16091644
SESSION_SECRET=
TOKEN_ENCRYPTION_KEY=
STRAVA_VERIFY_TOKEN=
APP_URL=http://localhost:3000
```

Open [http://localhost:3000](http://localhost:3000). Strava webhooks need a publicly reachable HTTPS callback; for local webhook development, use a secure tunnel and register its `/webhook` URL.

## Deploy on Render

`render.yaml` configures the Node web service and a persistent disk for encrypted account data. Set the Strava credentials, encryption key, session secret, target segment ID, webhook verification token, and canonical `APP_URL` in the Render environment. Register the matching HTTPS callback with the Strava application and `https://<your-domain>/webhook` as the webhook callback URL.

## Privacy and data

- lapped uses Strava’s `activity:read_all` and `activity:write` permissions to inspect a rider’s activities and update that rider’s own ride descriptions.
- Strava authorization tokens are encrypted at rest with AES-256-GCM. Production secrets belong in environment variables, not in Git.
- lapped keeps the account and short-lived processing data needed to operate the service. It does not keep a permanent archive of full Strava activities or segment efforts.
- Riders can revoke lapped’s access through lapped or their Strava account settings.
- Keep `.env`, service data, and deployment credentials out of Git.

## Tests

Run the automated checks with:

```sh
node --test test/*.test.js
```
