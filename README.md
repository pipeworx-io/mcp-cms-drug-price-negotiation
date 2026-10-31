# @pipeworx/cms-drug-price-negotiation

The Medicare negotiated Maximum Fair Price (MFP) for every drug CMS has selected under the Inflation Reduction Act drug price negotiation program, by year, with an explicit "not selected" answer for any other drug.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1863+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `mfp_lookup(drug, year?)` — the MFP per 30-day equivalent supply for a brand name, generic/active ingredient or NDC (e.g. Enbrel, Farxiga, Ofev), for each year 2026-2028: in effect, ended by deselection, not yet effective, or selected with the price not yet published. A drug on no selected list returns `selected: false` with a plain statement, never a zero.
- `mfp_selected_drugs(ipay?)` — every selected drug for an initial price applicability year (2026: 10 drugs, 2027: 15, 2028: 15 selected, prices not yet published) with its MFP by year.

## Auth

Keyless.

## Data sources

- CMS, Medicare Drug Price Negotiation Program, Selected Drug List and Maximum Fair Price data. US federal data, public domain.

The figures are a small table loaded from the gateway's key-value store, not fetched per request; every response carries `data_as_of` (the latest as-of date CMS stamps on the file). CMS reissues the data when it inflation-adjusts a price, deselects a drug or announces a cycle; refresh with `node scripts/bake-index.mjs > src/mfp-index-data.ts` and commit.

Notes for the next reader: the MFP is quoted per 30-day equivalent supply, not per unit or per package. Prices are inflation-adjusted each January, so a 2027 figure for a 2026-cycle drug differs from its 2026 figure. Stelara, Entresto, Xarelto and NovoLog/Fiasp are deselected, so their MFP ends 2026-12-31. Brand names are grouped as CMS groups them (for example Ozempic, Rybelsus and Wegovy share one MFP).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "cms-drug-price-negotiation": {
      "url": "https://gateway.pipeworx.io/cms-drug-price-negotiation/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/cms-drug-price-negotiation/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1863+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/mfp_lookup \
  -H 'Content-Type: application/json' \
  -d '{"drug":"Enbrel"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/mfp_lookup`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-cms-drug-price-negotiation` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/cms-drug-price-negotiation/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "cms-drug-price-negotiation": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-cms-drug-price-negotiation"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Cms Drug Price Negotiation data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
