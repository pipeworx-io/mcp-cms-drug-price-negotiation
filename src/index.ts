interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * CMS Medicare drug price negotiation: the Maximum Fair Price (MFP) for every
 * drug CMS has selected under the Inflation Reduction Act.
 *
 * Source: CMS, Medicare Drug Price Negotiation Program, Selected Drug List and
 * Maximum Fair Price data file (US federal data, public domain, no key).
 *
 * The figures are a small table (a few dozen drugs) that CMS reissues a few
 * times a year. It is baked by scripts/bake-index.mjs into src/mfp-index-data.ts
 * and loaded from KV by the gateway, which injects it as `args._bakedIndex`
 * (workers/gateway/src/pack-baked-indexes.json). NEVER value-import the data
 * module here: a value import puts the table into every isolate at startup
 * (fleet #2754). Type-only imports are fine.
 */
import type { MfpDrug, MfpSegment } from './mfp-index-data.js';

const SOURCE = 'CMS, Medicare Drug Price Negotiation Program (Selected Drug List and Maximum Fair Price data)';
const UNIT = 'US dollars per 30-day equivalent supply';
const YEARS = [2026, 2027, 2028];

let DRUGS: MfpDrug[] = [];
let FILE_AS_OF = '';
function ensureIndex(args: Record<string, unknown>): void {
  if (DRUGS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const drugs = idx?.MFP_DRUGS;
  const asOf = idx?.MFP_FILE_AS_OF;
  if (!Array.isArray(drugs) || drugs.length === 0 || typeof asOf !== 'string') {
    // Loud on purpose: answering from an empty table would read as "not selected".
    throw new Error(
      `cms-drug-price-negotiation: the Maximum Fair Price table is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it on the first call into this pack; this is a server-side fault, not a statement that the drug is unselected -- retry shortly.',
    );
  }
  DRUGS = drugs as MfpDrug[];
  FILE_AS_OF = asOf;
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

const tools: McpToolExport['tools'] = [
  {
    name: 'mfp_lookup',
    description:
      'Look up the Medicare negotiated Maximum Fair Price (MFP) for a drug selected under the Inflation Reduction Act drug price negotiation program, ' +
      'by brand name (Enbrel, Farxiga, Ofev), generic or active ingredient (etanercept, dapagliflozin) or NDC. Returns the price per 30-day equivalent supply ' +
      'for each year 2026-2028 (in effect, ended by deselection, not yet effective, or selected with the price not yet published), with the CMS source and data_as_of. ' +
      'A drug that is not on any selected list returns selected:false with an explicit statement, never a zero price.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        drug: { type: 'string', description: 'Brand name, generic/active ingredient, or NDC (e.g. "Enbrel", "dapagliflozin", "00003-0893")' },
        year: { type: 'number', description: 'Optional single year to return (2026, 2027 or 2028). Default: all three.' },
      },
      required: ['drug'],
    },
  },
  {
    name: 'mfp_selected_drugs',
    description:
      'List the drugs CMS has selected for Medicare drug price negotiation, with their Maximum Fair Prices. Filter by initial price applicability year ' +
      '(2026 = first cycle, announced 2024-08; 2027 = second cycle, 15 drugs; 2028 = third cycle, selected, prices not yet published as of the CMS file).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ipay: { type: 'number', description: 'Initial price applicability year: 2026, 2027 or 2028. Default: all.' },
      },
    },
  },
];

function yearStatus(d: MfpDrug, year: number) {
  const inYear = d.segments.filter((s: MfpSegment) => {
    const e = Number(s.effective.slice(0, 4));
    const en = s.end ? Number(s.end.slice(0, 4)) : null;
    if (s.end && s.end < s.effective) return false; // zero-length row left by a deselection
    return e <= year && (en === null || en >= year);
  });
  if (inYear.length) {
    const vals = [...new Set(inYear.map((s) => s.mfp_30day))].sort((a, b) => a - b);
    const latest = inYear.reduce((a, b) => (a.effective >= b.effective ? a : b));
    const carried = Number(latest.effective.slice(0, 4)) < year;
    return {
      year,
      status: 'in_effect',
      mfp_per_30_day_supply_usd: vals.length === 1 ? vals[0] : null,
      ...(vals.length > 1 ? { mfp_values_usd: vals, note: 'More than one MFP applies in this year (a mid-year recalculation or differing products).' } : {}),
      figure_effective_from: latest.effective,
      figure_as_of: latest.as_of,
      ...(carried ? { note: `Latest published figure carried forward; CMS inflation-adjusts the MFP each January and the ${year} adjustment is not in the file yet.` } : {}),
    };
  }
  const first = d.segments.length ? d.segments.reduce((a, b) => (a.effective <= b.effective ? a : b)) : null;
  if (!first) {
    return { year, status: 'selected_price_not_yet_published', mfp_per_30_day_supply_usd: null, note: `Selected for IPAY ${d.ipay}; the CMS file carries no Maximum Fair Price for it yet.` };
  }
  if (Number(first.effective.slice(0, 4)) > year) {
    return { year, status: 'not_yet_effective', mfp_per_30_day_supply_usd: null, note: `The MFP first takes effect ${first.effective}; no MFP applies in ${year}.` };
  }
  const last = d.segments.reduce((a, b) => ((a.end ?? '') >= (b.end ?? '') ? a : b));
  return {
    year,
    status: 'ended',
    mfp_per_30_day_supply_usd: null,
    note: `The MFP ended ${last.end ?? 'earlier'}${d.deselected ? ' because CMS deselected the drug (generic or biosimilar competition)' : ''}; no MFP applies in ${year}.`,
  };
}

function drugView(d: MfpDrug, years: number[]) {
  return {
    selected: true,
    ipay: d.ipay,
    selected_drug: d.names,
    active_ingredients: d.ingredients,
    deselected: d.deselected,
    ...(d.hcpcs.length ? { hcpcs_codes: d.hcpcs } : {}),
    ndc9_count: d.ndc9.length,
    unit: UNIT,
    by_year: years.map((y) => yearStatus(d, y)),
  };
}

function scoreMatch(d: MfpDrug, q: string, digits: string): number {
  if (digits.length >= 8 && d.ndc9.some((n) => n.replace(/-/g, '') === digits.slice(0, 9) || n.replace(/-/g, '') === digits.slice(0, 8))) return 3;
  const terms = [...d.names, ...d.ingredients].map(norm);
  if (terms.includes(q)) return 3;
  if (q.length >= 4 && terms.some((t) => t.split(' ').includes(q) || t.startsWith(q))) return 2;
  if (q.length >= 5 && terms.some((t) => t.includes(q) || q.includes(t))) return 1;
  return 0;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  const meta = { source: SOURCE, data_as_of: FILE_AS_OF };
  switch (name) {
    case 'mfp_lookup': {
      const raw = String(args.drug ?? '').trim();
      if (!raw) throw new Error('mfp_lookup requires `drug` (a brand name, ingredient or NDC).');
      let years = YEARS;
      if (args.year !== undefined && args.year !== null && args.year !== '') {
        const y = Number(args.year);
        if (!YEARS.includes(y)) throw new Error(`year must be one of ${YEARS.join(', ')} (got ${String(args.year)}).`);
        years = [y];
      }
      const q = norm(raw);
      const digits = raw.replace(/\D/g, '');
      const scored = DRUGS.map((d) => ({ d, s: scoreMatch(d, q, digits) })).filter((x) => x.s > 0);
      const best = scored.reduce((m, x) => Math.max(m, x.s), 0);
      const hits = scored.filter((x) => x.s === best).map((x) => x.d);
      if (!hits.length) {
        return {
          selected: false,
          query: raw,
          message:
            `"${raw}" is not on any CMS Medicare drug price negotiation selected-drug list (initial price applicability years 2026, 2027 and 2028) as of ${FILE_AS_OF}, ` +
            'so no negotiated Maximum Fair Price exists for it. This is a statement about the lists, not a zero price.',
          lists_checked: YEARS.map((y) => ({ ipay: y, drugs: DRUGS.filter((d) => d.ipay === y).length })),
          hint: 'Call mfp_selected_drugs to see every selected drug.',
          ...meta,
        };
      }
      return { query: raw, matches: hits.map((d) => drugView(d, years)), unit: UNIT, ...meta };
    }
    case 'mfp_selected_drugs': {
      let ipay: number | null = null;
      if (args.ipay !== undefined && args.ipay !== null && args.ipay !== '') {
        ipay = Number(args.ipay);
        if (!YEARS.includes(ipay)) throw new Error(`ipay must be one of ${YEARS.join(', ')} (got ${String(args.ipay)}).`);
      }
      const list = DRUGS.filter((d) => ipay === null || d.ipay === ipay);
      return {
        count: list.length,
        unit: UNIT,
        drugs: list.map((d) => {
          const ys = YEARS.filter((y) => y >= d.ipay).map((y) => yearStatus(d, y));
          return {
            ipay: d.ipay,
            selected_drug: d.names,
            active_ingredients: d.ingredients,
            deselected: d.deselected,
            mfp_by_year: ys.map((y) => ({ year: y.year, status: y.status, mfp_per_30_day_supply_usd: y.mfp_per_30_day_supply_usd })),
          };
        }),
        ...meta,
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
