# Engagement

Copy this file to `ENGAGEMENT.md` in the workspace root and fill it in. Do not put passwords or tokens here.

## Authorisation
- Who owns the systems below, and who approved testing:
- Window (dates and hours, with timezone):
- Contact if something breaks:

## In scope (hosts only, one per line; staging or local copies)
- https://staging.example.com

## Out of scope
- Production hosts, third-party services (payment, email, SMS, identity providers), anything not listed above.

## Rules
- Rate ceiling: 5 requests per second per host, at most 5 parallel requests.
- Denial of service, destructive writes, mass email or SMS: not allowed.
- Stop and tell the user when the target returns repeated 5xx or 429.

## Test accounts
- Names and roles only (for example `user-a` and `user-b`, ordinary users; `admin-t`, test admin). Credentials are given in the chat session only when the user chooses to, never stored here.

## Repositories (read only)
- owner/repo (read through `dsh-git login --repo owner/repo`)

## Known issues to skip
-
