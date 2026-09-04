"""Shared transient-failure retry for every outbound scraper request.

WHY THIS EXISTS
---------------
Weekly LOI Sync failed 3 of its last 5 scheduled GitHub Actions runs. The
2026-08-31 failure log is one line:

    requests.exceptions.HTTPError: 503 Server Error: Service Unavailable for
    url: https://drs.faa.gov/api/browse/doctype/LEGAL_INTERPRETATIONS/documents/metadatas

That is the FAA's DRS having a bad moment, not a bug in our parsing. But every
scraper called `resp.raise_for_status()` with no retry anywhere, so a single
transient 5xx from an upstream we do not control killed the entire weekly sync
for that corpus. The content only stayed current because someone noticed and
re-ran it by hand (LOI's next successful run was a manual one on 09-02).

A scheduled job that depends on a human noticing it failed is not scheduled.

WHAT THIS DOES
--------------
`retrying_session()` returns a `requests.Session` with urllib3's own Retry
mounted on both http:// and https://. Retries are attempted ONLY for:

  * connection and read errors (socket resets, DNS blips, timeouts)
  * 429 Too Many Requests
  * 500 / 502 / 503 / 504

with exponential backoff (0.8s, 1.6s, 3.2s, 6.4s, 12.8s) and a hard cap on
attempts, so a genuinely-down upstream still fails the run in ~25s of waiting
rather than hanging the job.

Deliberately NOT retried:
  * 4xx other than 429 -- a 401/403 means the DRS JWT expired (see
    loi_scraper's `_check_auth_response`) and a 404 means the document really
    is gone. Retrying either just burns time before reporting the same real
    problem, and would mask the auth-expiry case this project already has
    explicit handling for.
  * POSTs to Supabase -- those are our own writes; a 5xx there is worth
    surfacing immediately rather than silently re-attempting a partial write.
    Callers mount this on the SESSION used for upstream FAA/eCFR fetches.

`allowed_methods` includes POST because DRS's browse/search API is POST-based
(`/api/browse/doctype/.../metadatas` takes a JSON page body). Those calls are
reads in everything but HTTP verb -- they fetch a page of metadata and have no
side effects -- so retrying them is safe. urllib3 excludes POST from its
default retry set precisely because POST is usually non-idempotent, which is
why this has to be stated explicitly rather than relied on.
"""

from __future__ import annotations

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# 5 attempts total: the initial request plus 4 retries.
DEFAULT_ATTEMPTS = 4
DEFAULT_BACKOFF = 0.8
RETRY_STATUSES = (429, 500, 502, 503, 504)


def retry_policy(attempts: int = DEFAULT_ATTEMPTS, backoff: float = DEFAULT_BACKOFF) -> Retry:
    return Retry(
        total=attempts,
        connect=attempts,
        read=attempts,
        status=attempts,
        backoff_factor=backoff,
        status_forcelist=RETRY_STATUSES,
        allowed_methods=frozenset(["GET", "HEAD", "OPTIONS", "POST"]),
        raise_on_status=False,  # let the caller's own raise_for_status() report it
        respect_retry_after_header=True,
    )


def mount_retries(session: requests.Session,
                  attempts: int = DEFAULT_ATTEMPTS,
                  backoff: float = DEFAULT_BACKOFF) -> requests.Session:
    """Attach the retry policy to an EXISTING session, preserving its headers.

    Used by the scrapers that already build a Session with auth headers on it
    (DRS jwt/user, User-Agent, Referer) -- mounting in place keeps that setup
    untouched instead of rebuilding it here.
    """
    adapter = HTTPAdapter(max_retries=retry_policy(attempts, backoff))
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def retrying_session(attempts: int = DEFAULT_ATTEMPTS,
                     backoff: float = DEFAULT_BACKOFF) -> requests.Session:
    """A fresh Session with retries already mounted."""
    return mount_retries(requests.Session(), attempts, backoff)
