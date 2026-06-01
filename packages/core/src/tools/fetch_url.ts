import { jsonSchema } from "ai";
import type { Tool } from "./types.js";

export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description:
    "Fetch a web page and return its content as plain text. HTML tags, scripts, and styles are stripped automatically.",
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
        headers: { "User-Agent": "kda/0.1" },
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
    if (!contentType.includes("text/") && !contentType.includes("json") && !contentType.includes("xml")) {
      return `Error: unsupported content type "${contentType}" for "${url}". Only text-based pages are supported.`;
    }

    const html = await response.text();

    // Strip <script> and <style> blocks entirely
    const noScriptStyle = html
      .replace(/<script[\s>][^]*?<\/script>/gi, "")
      .replace(/<style[\s>][^]*?<\/style>/gi, "");

    // Remove all HTML tags
    const noTags = noScriptStyle.replace(/<[^>]+>/g, "");

    // Decode common HTML entities
    const decoded = noTags
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ");

    // Collapse whitespace while preserving line breaks
    const collapsed = decoded
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0)
      .join("\n");

    return collapsed || "(empty page)";
  },
  readOnly: true,
  parallelizable: true,
  maxResultLength: 50_000,
};
