export async function handler(input, ctx) {
  try {
    if (!input || typeof input !== "object") {
      throw new Error("Invalid input: expected an object.");
    }
    const rawTicker = input.ticker;
    if (typeof rawTicker !== "string" || !rawTicker.trim()) {
      throw new Error("Invalid input: 'ticker' must be a non-empty string.");
    }
    const ticker = rawTicker.trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker)) {
      throw new Error("Invalid input: 'ticker' contains invalid characters.");
    }

    const fetchFn =
      (ctx && typeof ctx.fetch === "function" && ctx.fetch) ||
      (typeof fetch === "function" && fetch) ||
      (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function" && globalThis.fetch);

    if (typeof fetchFn !== "function") {
      throw new Error("Missing fetch capability in context.");
    }

    const userAgent =
      (ctx && ctx.userAgent) ||
      "SEC Filing Explorer/1.0 (contact: support@example.com)";

    async function fetchJson(url) {
      const res = await fetchFn(url, {
        method: "GET",
        headers: {
          "User-Agent": userAgent,
          "Accept-Encoding": "gzip, deflate",
          Accept: "application/json"
        }
      });
      if (!res || !res.ok) {
        const status = res && res.status ? res.status : "unknown";
        throw new Error("Request failed with status " + status + " for " + url);
      }
      const data = await res.json();
      if (data == null) {
        throw new Error("Empty response from " + url);
      }
      return data;
    }

    const tickerListUrl = "https://www.sec.gov/files/company_tickers.json";
    const tickerData = await fetchJson(tickerListUrl);

    let entries = [];
    if (Array.isArray(tickerData)) {
      entries = tickerData;
    } else if (tickerData && typeof tickerData === "object") {
      entries = Object.keys(tickerData).map((k) => tickerData[k]);
    } else {
      throw new Error("Unexpected ticker list format.");
    }

    let match = null;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e && typeof e.ticker === "string" && e.ticker.toUpperCase() === ticker) {
        match = e;
        break;
      }
    }
    if (!match || typeof match.cik_str === "undefined") {
      return { ticker, filings: [] };
    }

    const cikNum = String(match.cik_str).padStart(10, "0");
    const submissionsUrl = "https://data.sec.gov/submissions/CIK" + cikNum + ".json";
    const submissions = await fetchJson(submissionsUrl);

    const recent = submissions && submissions.filings && submissions.filings.recent;
    if (!recent || typeof recent !== "object") {
      return { ticker, filings: [] };
    }

    const forms = Array.isArray(recent.form) ? recent.form : [];
    const filedAt = Array.isArray(recent.filingDate) ? recent.filingDate : [];
    const accession = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];

    const count = Math.min(forms.length, filedAt.length, accession.length);
    const filings = [];
    for (let i = 0; i < count; i++) {
      const form = forms[i];
      const date = filedAt[i];
      const acc = accession[i];
      if (typeof form === "string" && typeof date === "string" && typeof acc === "string") {
        filings.push({ form, filedAt: date, accession: acc });
      }
    }

    return { ticker, filings };
  } catch (err) {
    const message = err && err.message ? err.message : "Unknown error";
    throw new Error("search_filings failed: " + message);
  }
}