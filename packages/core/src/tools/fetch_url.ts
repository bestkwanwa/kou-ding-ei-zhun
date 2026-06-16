import { jsonSchema } from "ai";
import TurndownService from "turndown";
import type { Tool } from "./types.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description:
    "Fetch a web page and return its content as Markdown. " +
    "Useful for getting the full content of URLs found via web_search.",
  parameters: jsonSchema({
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch",
      },
    },
    required: ["url"],
  }),
  async execute(args) {
    const url = args.url as string;

    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError") {
        return `Error: request timed out: "${url}"`;
      }
      return `Error: failed to fetch "${url}": ${e.message}`;
    }

    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText} for "${url}"`;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("text/plain") &&
      !contentType.includes("json")
    ) {
      return `Error: unsupported content type "${contentType}" for "${url}". Only HTML and text pages are supported.`;
    }

    const raw = await response.text();

    // If plain text or JSON, return as-is
    if (contentType.includes("text/plain") || contentType.includes("json")) {
      return raw;
    }

    // Strip <script> and <style> blocks before converting to Markdown
    const cleaned = raw
      .replace(/<script[\s>][^]*?<\/script>/gi, "")
      .replace(/<style[\s>][^]*?<\/style>/gi, "")
      .replace(/<nav[\s>][^]*?<\/nav>/gi, "")
      .replace(/<footer[\s>][^]*?<\/footer>/gi, "");

    const markdown = turndown.turndown(cleaned);

    // Collapse excessive blank lines
    const collapsed = markdown.replace(/\n{3,}/g, "\n\n").trim();

    return collapsed || "(empty page)";
  },
  readOnly: true,
  parallelizable: true,
  maxResultLength: 50_000,
  lazy: true,
  hint: "fetch web page url markdown html request http",
  cleanable: true,
};
