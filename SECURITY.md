# Security Policy

Lapped stores Strava authorization tokens encrypted at rest and keeps deployment credentials out of version control. The project uses HTTPS in production, secure/HttpOnly cookies, signed owner-dashboard access, webhook verification, narrowly scoped Strava API permissions, and seven-day expiry for activity-processing records.

## Reporting a vulnerability

Please do not include exploit details, credentials, tokens, or personal activity data in a public GitHub issue. Use GitHub's private vulnerability reporting for this repository when available, or contact the repository owner privately through GitHub with a concise description and safe reproduction steps.

## Deployment responsibility

Anyone deploying a fork must create new Strava credentials and secrets, configure `ADMIN_ATHLETE_ID`, enable two-factor authentication on the hosting and source-control accounts, and never reuse production token data.
