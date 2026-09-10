# Strava API Program application

## Request

Request Standard Tier athlete capacity beyond 10 registered users for the primary Lapped application (Strava client ID `180419`).

## Form values

| Field | Value |
| --- | --- |
| First name | Michael |
| Last name | Wu |
| Company name | Lapped |
| API application name | Lapped |
| Strava client ID | 180419 |
| Additional apps | None |
| Currently authenticated users | 8 (checked September 10, 2026) |
| Intended users | 100 in the next 12 months |
| Support URL | https://lapped.fit/privacy.html |

Use the account email that Michael monitors for Strava Developer Program correspondence.

## Application description

Lapped is a private, per-athlete High Park lap counter for Toronto riders. A rider explicitly consents on lapped.fit, then authorizes Lapped with Strava OAuth. Lapped uses `activity:read_all` to read that rider’s activity and segment efforts after an activity webhook, checks for completed efforts on the configured High Park lap segment, and uses `activity:write` to add a short lap receipt to that rider’s own activity description. If the activity has no matching completed lap, Lapped leaves the description unchanged.

Lapped uses only the authenticated athlete’s data to provide this feature. It does not publish a public leaderboard, profiles, or cross-athlete activity data; it does not sell data, use it for ads, AI, or analytics, and does not maintain a historical activity archive. Authorization tokens are encrypted at rest. Short-lived activity-processing records expire after seven days. Athletes can disconnect at any time from Lapped; disconnecting revokes Lapped’s access and deletes that athlete’s stored authorization and operational records. The public privacy notice explains data use, withdrawal, access, and deletion: https://lapped.fit/privacy.html

## Screenshots to attach

1. Homepage before connection, showing the consent notice and “Connect with Strava” flow.
2. Privacy page, showing data-use, retention, withdrawal, access, and deletion information.
3. Homepage after connection, showing only the connected athlete’s own identity and the disconnect control.

Do not upload admin pages, other athletes’ data, API credentials, or screenshots containing personal activity data.
