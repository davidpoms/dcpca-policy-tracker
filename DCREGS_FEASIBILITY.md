# DC Register ingestion feasibility spike

`GET /api/scrape-dcregs` runs a bounded, read-only diagnostic from the Vercel function environment. It tests direct access to the DCRegs homepage and the two known notice pages, optionally sends insufficient responses through the existing `SCRAPINGBEE_API_KEY` configuration, characterizes returned content, parses notice metadata, probes a discoverable **View text** target, and attempts to discover and enumerate the September 18, 2026 Register issue.

The route requires the exact header `Authorization: Bearer ${CRON_SECRET}` and fails closed when `CRON_SECRET` is absent. `x-vercel-cron` is not accepted. The response contains request status and content classification, parsed metadata, issue-discovery evidence and samples, request counts, and explicit viability flags. It never returns raw HTML, credentials, cookies, or the ScrapingBee key. It performs only outbound GET requests and makes no Supabase or other persistent writes.

Every direct or discovered target must use HTTPS and have the exact hostname `dcregs.dc.gov` or `www.dcregs.dc.gov`. Direct redirects are handled manually, limited to three hops, and revalidated at each hop. Every external request has a 12-second timeout. HTML and document reads are stopped at 2 MB even when an upstream server ignores `Range`.

Discovery is capped at two issue-browser pages, two target-issue pages, six category pages, and ten returned sample notices. A direct request is preferred; ScrapingBee is used only after direct content validation fails, and rendered mode is attempted only after a normal proxy response is insufficient.

## Preview validation

Deploy this branch to Vercel Preview, then invoke:

```text
Invoke `GET https://<preview-host>/api/scrape-dcregs` with the exact `Authorization: Bearer ${CRON_SECRET}` header.
```

Evaluate the `direct`, `scrapingBee`, `knownNoticeParsing`, `viewText`, `issueDiscovery`, and `conclusion` sections from the Preview runtime. A configured ScrapingBee key enables normal proxy requests and rendered-JS fallback only where the normal response is insufficient; an absent key is reported as `not configured` without failing the probe.

Content validation is structural and page-specific. Broad block phrases can occur inside otherwise valid ASP.NET scripts or templates, so the classifier reports them as diagnostic `blockSignals` without overriding strong homepage or matching Notice Detail structure. ScrapingBee remains a fallback only when direct retrieval fails structural validation.

Notice Detail validation reports field-presence and parsed public-metadata diagnostics without returning HTML. Homepage diagnostics also report up to fifteen sanitized navigation controls, structured postback/window-open indicators, allowed same-site targets, and the presence—but never the values—of ASP.NET state fields. These diagnostics do not implement ASP.NET POST navigation or change viability conclusions.

When structured table/cell parsing misses Notice Detail metadata, the diagnostic parser falls back to normalized visible text with scripts and styles removed and values bounded by known DCRegs labels. Homepage navigation diagnostics include at most fifteen eligible inputs, buttons, and relevant links, including controls located near the browse label even when the control itself has no visible text.

This spike does **not** establish that ingestion is viable unless the September 18, 2026 issue is positively identified, a target issue or descended category page is fetched, and at least one notice is enumerated from that target chain. Generic browse-page notices and successful parsing of the two known individual notices do not count. No production workflow, tracked item, candidate record, report, schedule, or database table is created or modified.
