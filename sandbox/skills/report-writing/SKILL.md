---
name: report-writing
description: Write up security findings as a clear Markdown report with severity, evidence, impact and fix for each, plus what was and was not tested.
---

# Writing the report

Write `REPORT.md` in the workspace root, from `notes.md` and `evidence/`. Write for the people who will fix the issues: engineers and the owner of the system.

## Structure

1. **Summary**: scope, dates, what was tested and how (black-box, code review, or both), the number of findings by severity, and the two or three that matter most, in plain words.
2. **Scope and limits**: hosts and repositories tested, rate and time limits, test accounts used (names only), and what was **not** tested and why.
3. **Findings**, most severe first. For each:
   - **Title** (what and where) and **ID** (F-01, F-02, ...).
   - **Severity**: Critical, High, Medium, Low or Info, with one sentence on why. Rate by real impact in this application, not by the scanner's label. If you use CVSS, show the vector.
   - **Status**: confirmed (reproduced by hand), or unconfirmed (lead only).
   - **Where**: URL and parameter, or file and line.
   - **Description and impact**: what an attacker can do, and what it would take.
   - **Evidence**: the exact request and the relevant part of the response, redacted (no real personal data, no full tokens), and steps to reproduce.
   - **Fix**: a concrete change, with a short code example when it helps.
   - **References**: CWE, OWASP category, advisory links where they apply.
4. **Checked and fine**: areas tested with no issue found.
5. **Appendix**: tools and versions, commands run (with the rate options), and the evidence files.

## Rules

- No secrets, tokens, passwords or real personal data in the report. Redact them and say where the original is.
- Do not overstate: separate what was shown from what is suspected.
- Do not include findings you could not reproduce, except in a clearly marked "leads" list.
- If a finding exposes real data or a live credential, say so at the top and recommend rotation now, before the full report is read.
- Keep it short enough to be read. One finding, one page at most.
