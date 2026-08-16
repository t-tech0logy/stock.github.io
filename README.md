# PlainStock

PlainStock is a plain-English, educational stock-price research dashboard. It separates price-trend evidence from company quality, valuation, and personal suitability.

## Public-site structure

- `index.html` — interactive stock dashboard
- `learn/` — original educational library
- `stocks/` — permanent stock research starting points
- `about.html`, `methodology.html`, `disclaimer.html`, `privacy.html`, `terms.html`, `contact.html` — trust and policy pages
- `worker/` — protected market-data and assistant API boundary

## Safe API setup

Never add provider credentials to `config.js`, `assistant-config.js`, HTML, or browser JavaScript. The public configuration files contain only the URL of a separately deployed Worker.

1. Copy `worker/wrangler.toml.example` to `worker/wrangler.toml`.
2. Set the correct production and local origins in `ALLOWED_ORIGINS`.
3. Add `MARKET_API_KEY` and `GEMINI_API_KEY` through the hosting provider's secret-storage command or dashboard.
4. Deploy the Worker.
5. Put the Worker URL in `marketProxyRoot` and `assistantProxyRoot` in the two public configuration files.
6. Test rate limits, allowed routes, provider quotas, and error responses before publishing.

The included in-memory limiter reduces casual abuse but is not globally durable. A production launch should also enable the host's edge rate-limiting product and hard provider quotas.

## Publishing checklist

- Obtain permission for public and commercial display of market data and derived analytics.
- Replace the GitHub Pages canonical URL if a custom domain is connected.
- Verify every policy page against the actual providers and jurisdiction.
- Add privacy-conscious analytics and submit `sitemap.xml` to search engines.
- Do not activate advertising until the privacy policy and consent mechanism match the final ad configuration.
- After AdSense approval, copy `ads.txt.example` to `ads.txt`, replace the placeholder publisher ID, and add one clearly labelled unit to the reserved slot.

## Credential incident note

Earlier repository versions contained client-side test credentials. Those credentials must be revoked. Removing them from the current files does not remove them from Git history.

## Local preview

Serve the repository through a local HTTP server rather than opening files directly. Add that local origin to the Worker's `ALLOWED_ORIGINS` only during testing.
