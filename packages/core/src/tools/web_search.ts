import { jsonSchema } from "ai";
import type { Tool } from "./types.js";

/**
 * Detect which search provider is available based on env vars.
 * Priority: Tavily > Serper
 */
function detectProvider(): { provider: "tavily" | "serper"; apiKey: string } | null {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (tavilyKey) return { provider: "tavily", apiKey: tavilyKey };

  const serperKey = process.env.SERPER_API_KEY;
  if (serperKey) return { provider: "serper", apiKey: serperKey };

  return null;
}

// ---------------------------------------------------------------------------
// Tavily: search + content extraction in one call
// ---------------------------------------------------------------------------

async function searchTavily(query: string, apiKey: string): Promise<string> {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      include_answer: true,
      max_results: 5,
    }),
  });

  if (!resp.ok) {
    return `Error: Tavily API returned HTTP ${resp.status} ${resp.statusText}`;
  }

  const data = (await resp.json()) as {
    answer?: string;
    results?: Array<{ title: string; url: string; content: string }>;
  };

  const parts: string[] = [];

  if (data.answer) {
    parts.push(`## Answer\n${data.answer}\n`);
  }

  if (data.results?.length) {
    parts.push("## Sources");
    for (const r of data.results) {
      parts.push(`### ${r.title}\nURL: ${r.url}\n${r.content}\n`);
    }
  }

  return parts.join("\n") || "No results found.";
}

// ---------------------------------------------------------------------------
// Serper: Google search, returns snippets only
// ---------------------------------------------------------------------------

async function searchSerper(query: string, apiKey: string): Promise<string> {
  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ q: query }),
  });

  if (!resp.ok) {
    return `Error: Serper API returned HTTP ${resp.status} ${resp.statusText}`;
  }

  const data = (await resp.json()) as {
    organic?: Array<{ title: string; link: string; snippet: string }>;
  };

  if (!data.organic?.length) return "No results found.";

  const lines = data.organic.map(
    (r, i) => `${i + 1}. **${r.title}**\n   ${r.link}\n   ${r.snippet}`,
  );

  return (
    lines.join("\n\n") +
    "\n\nUse fetch_url to get the full content of any result."
  );
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web for information. Returns relevant results with summaries. " +
    "For full page content, use fetch_url on specific URLs from the results.",
  parameters: jsonSchema({
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
    },
    required: ["query"],
  }),
  async execute(args) {
    const query = args.query as string;

    const provider = detectProvider();
    if (!provider) {
      return "Error: no search API key configured. Set TAVILY_API_KEY or SERPER_API_KEY in environment.";
    }

    try {
      if (provider.provider === "tavily") {
        return await searchTavily(query, provider.apiKey);
      }
      return await searchSerper(query, provider.apiKey);
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError") {
        return `Error: search request timed out for "${query}"`;
      }
      return `Error: search failed: ${e.message}`;
    }
  },
  readOnly: true,
  parallelizable: true,
  maxResultLength: 50_000,
  lazy: true,
  hint: "search web internet query tavily serper google online",
};
