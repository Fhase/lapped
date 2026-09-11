# Lapped

[Lapped](https://lapped.fit) is a small Strava companion for the High Park loop in Toronto. Connect Strava, finish the configured loop, and Lapped adds a simple receipt to the activity description:

```text
laps: 14
fastest lap: 2:38 · 42.3 km/h
www.lapped.fit
```

If an activity has no completed effort for the configured High Park segment, Lapped leaves its description untouched. It preserves any rider-written description and replaces only its own receipt when a ride is rescanned.

## How it works

1. A rider authorizes Lapped with Strava.
2. Strava sends Lapped an activity webhook after upload or update.
3. Lapped reads that rider's activity, counts efforts on the configured segment, and writes the receipt only when there is at least one match.

Lapped is intentionally a personal utility: it does not provide public leaderboards, cross-athlete rankings, or historical activity archives.

The included Chrome extension is optional. It lets a rider manually rescan an existing Strava activity.

## Privacy and security

- Lapped requests Strava's `activity:read_all` and `activity:write` scopes. Those permissions are needed to inspect segment efforts and write the receipt to the rider's own activity description.
- Connected-athlete tokens are stored on the service's persistent disk encrypted with AES-256-GCM. The encryption key and all Strava credentials live only in environment variables, never in this repository.
- Athlete ID, display name, connection time, and encrypted tokens are retained only while a rider remains connected. The duplicate-prevention cache is pruned within seven days; activity and segment-effort history are not retained.
- Riders can view the account data Lapped retains at `/account/data` while connected, and can request correction or deletion through the privacy route described on the site.
- `data/`, `.env`, deployment keys, and dependency folders are excluded from Git.
- The owner dashboard is protected by Strava authentication, an owner-only athlete check, and a signed, HttpOnly, secure cookie. It is not a hidden public page.
- Riders can revoke access at any time from Lapped or their Strava account settings. Revocation removes their authorization and stored operational records.

No web service can honestly promise to be unhackable. Keep the deployment platform and GitHub account protected with strong, unique passwords and two-factor authentication; rotate credentials promptly if there is any concern they were exposed.

## Run locally

1. Create a Strava API application. For local development, set its authorization callback domain to `localhost`.
2. Copy `.env.example` to `.env` and supply the values below.
3. Run `npm install && npm run dev`.
4. Visit `http://localhost:3000`, connect Strava, then optionally load `extension/` through Chrome's `chrome://extensions` page (Developer mode → **Load unpacked**).

Required environment variables:

```text
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
HIGH_PARK_SEGMENT_ID=16091644
SESSION_SECRET=
TOKEN_ENCRYPTION_KEY=
STRAVA_VERIFY_TOKEN=
```

`ADMIN_ATHLETE_ID` is also recommended for every independent deployment; it must be the Strava athlete ID allowed to view `/admin`.

## Deploy on Render

`render.yaml` creates the web service and a 1 GB persistent disk for encrypted token data. In Render, enter the Strava client ID, client secret, and the owner athlete ID as protected environment variables. Set `APP_URL` to the public URL when using a custom domain. Then set that hostname as the Strava application's authorization callback domain and register `https://<your-host>/webhook` as the Strava webhook callback.

The canonical live Lapped deployment is [lapped.fit](https://lapped.fit), including the private owner page at [lapped.fit/admin](https://lapped.fit/admin).

## Security reports

Please do not post security-sensitive details in a public issue. Use GitHub's private vulnerability reporting for this repository when it is available, or contact the repository owner privately through GitHub.
