import { z } from "zod";
import type { Tool, ToolResult } from "../../Tool.js";

const SEARCH_TYPES = ["auto", "neural", "fast", "keyword"] as const;
const CATEGORIES = ["company", "research paper", "news", "personal site", "financial report", "people"] as const;

const inputSchema = z.object({
  query: z.string(),
  num_results: z.number().optional(),
  type: z.enum(SEARCH_TYPES).optional(),
  category: z.enum(CATEGORIES).optional(),
  include_domains: z.array(z.string()).optional(),
  exclude_domains: z.array(z.string()).optional(),
  include_text: z.array(z.string()).optional(),
  exclude_text: z.array(z.string()).optional(),
  start_published_date: z.string().optional(),
  end_published_date: z.string().optional(),
  user_location: z.string().optional(),
  text: z.boolean().optional(),
  highlights: z.boolean().optional(),
  summary: z.boolean().optional(),
  summary_query: z.string().optional(),
  max_text_chars: z.number().optional(),
});

const DEFAULT_NUM_RESULTS = 5;
const MAX_TEXT_CHARS = 1500;
const ENDPOINT = "https://api.exa.ai/search";
const INTEGRATION_HEADER = "openharness";

type ExaContents = {
  text?: boolean | { maxCharacters?: number };
  highlights?: boolean | { maxCharacters?: number };
  summary?: boolean | { query?: string };
};

type ExaRequest = {
  query: string;
  numResults: number;
  type?: (typeof SEARCH_TYPES)[number];
  category?: (typeof CATEGORIES)[number];
  includeDomains?: string[];
  excludeDomains?: string[];
  includeText?: string[];
  excludeText?: string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
  userLocation?: string;
  contents?: ExaContents;
};

type ExaResultItem = {
  id?: string;
  url: string;
  title?: string | null;
  publishedDate?: string;
  author?: string | null;
  text?: string;
  highlights?: string[];
  summary?: string;
};

type ExaResponse = {
  results: ExaResultItem[];
  requestId?: string;
};

export function buildRequestBody(input: z.infer<typeof inputSchema>): ExaRequest {
  const body: ExaRequest = {
    query: input.query,
    numResults: input.num_results ?? DEFAULT_NUM_RESULTS,
  };

  if (input.type) body.type = input.type;
  if (input.category) body.category = input.category;
  if (input.include_domains?.length) body.includeDomains = input.include_domains;
  if (input.exclude_domains?.length) body.excludeDomains = input.exclude_domains;
  if (input.include_text?.length) body.includeText = input.include_text;
  if (input.exclude_text?.length) body.excludeText = input.exclude_text;
  if (input.start_published_date) body.startPublishedDate = input.start_published_date;
  if (input.end_published_date) body.endPublishedDate = input.end_published_date;
  if (input.user_location) body.userLocation = input.user_location;

  const wantText = input.text ?? true;
  const wantHighlights = input.highlights ?? true;
  const wantSummary = input.summary ?? false;

  const contents: ExaContents = {};
  if (wantText) {
    contents.text = { maxCharacters: input.max_text_chars ?? MAX_TEXT_CHARS };
  }
  if (wantHighlights) {
    contents.highlights = true;
  }
  if (wantSummary) {
    contents.summary = input.summary_query ? { query: input.summary_query } : true;
  }
  if (Object.keys(contents).length > 0) {
    body.contents = contents;
  }

  return body;
}

export function extractSnippet(item: ExaResultItem): string {
  if (item.highlights && item.highlights.length > 0) {
    return item.highlights.join(" … ");
  }
  if (item.summary) return item.summary;
  if (item.text) {
    const trimmed = item.text.replace(/\s+/g, " ").trim();
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
  }
  return "";
}

export function formatResults(response: ExaResponse): string {
  if (!response.results || response.results.length === 0) {
    return "No results found.";
  }
  return response.results
    .map((r, i) => {
      const title = r.title?.trim() || "(untitled)";
      const snippet = extractSnippet(r);
      const meta: string[] = [];
      if (r.author) meta.push(`by ${r.author}`);
      if (r.publishedDate) meta.push(r.publishedDate.slice(0, 10));
      const metaLine = meta.length ? `   ${meta.join(" · ")}\n` : "";
      const snippetLine = snippet ? `   ${snippet}\n` : "";
      return `${i + 1}. ${title}\n   ${r.url}\n${metaLine}${snippetLine}`.trimEnd();
    })
    .join("\n\n");
}

export const ExaSearchTool: Tool<typeof inputSchema> = {
  name: "ExaSearch",
  description:
    "Search the web with Exa — neural/fast/auto search with content retrieval, domain and date filters, and category targeting.",
  inputSchema,
  riskLevel: "medium",

  isReadOnly() {
    return true;
  },

  isConcurrencySafe() {
    return true;
  },

  async call(input, _context): Promise<ToolResult> {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) {
      return {
        output: "Error: EXA_API_KEY environment variable is not set.",
        isError: true,
      };
    }

    const body = buildRequestBody(input);

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "x-exa-integration": INTEGRATION_HEADER,
          "User-Agent": "OpenHarness/1.0",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        const detail = errText ? `: ${errText.slice(0, 500)}` : "";
        return {
          output: `Error: Exa API returned ${response.status} ${response.statusText}${detail}`,
          isError: true,
        };
      }

      const json = (await response.json()) as ExaResponse;
      return { output: formatResults(json), isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error performing Exa search: ${message}`, isError: true };
    }
  },

  prompt() {
    return `Search the web using Exa's neural search engine and return ranked results with snippets. Requires EXA_API_KEY env var. Parameters:
- query (string, required): The search query.
- num_results (number, optional): Max results to return (default 5).
- type (string, optional): "auto" (default), "neural", "fast", or "keyword".
- category (string, optional): One of "company", "research paper", "news", "personal site", "financial report", "people".
- include_domains (string[], optional): Restrict to these domains.
- exclude_domains (string[], optional): Skip these domains.
- include_text (string[], optional): Results must contain these phrases.
- exclude_text (string[], optional): Skip results containing these phrases.
- start_published_date / end_published_date (string, optional): ISO 8601 publication date filters.
- user_location (string, optional): Two-letter ISO country code.
- text (boolean, optional): Include page text (default true).
- highlights (boolean, optional): Include highlight snippets (default true).
- summary (boolean, optional): Include AI-generated summary (default false).
- summary_query (string, optional): Custom summarization query.
- max_text_chars (number, optional): Cap text length per result (default 1500).`;
  },
};
