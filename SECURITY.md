# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose API
credentials, private data, or permit abuse of the deployed GeoJobs service.

Report security concerns privately to the maintainer using the contact details
shown on the GeoJobs website or GitHub profile.

## Secrets

GeoJobs is designed so API credentials remain in Google Apps Script Script
Properties. Do not commit API keys, tokens, passwords, credentials, or local
secret files to this repository.

The public Apps Script web-app URL used by the browser is intentionally
client-visible and is not treated as a secret.

If a secret is accidentally committed, revoke or rotate it immediately; simply
deleting it in a later commit does not remove it from Git history.
