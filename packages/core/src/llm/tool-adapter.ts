import { tool as aiTool, type ToolSet } from "ai";
import { z } from "zod";
import type { Tool, ToolContext } from "../tools/types.js";

/**
 * Converts our Tool[] into an AI SDK ToolSet.
 * Re-interprets the JSON Schema parameters as Zod schemas
 * for the AI SDK tool() helper.
 */
export function toAiSdkTools(tools: Tool[], ctx: ToolContext): ToolSet {
  const result: ToolSet = {};

  for (const t of tools) {
    const zodSchema = jsonSchemaToZod(t.parameters);
    // Type assertion needed: AI SDK tool() overloads can't infer
    // execute types from a dynamically-constructed Zod schema.
    result[t.name] = aiTool({
      description: t.description,
      parameters: zodSchema,
      execute: async (args: Record<string, unknown>) => {
        return t.execute(args, ctx);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as ToolSet[string];
  }

  return result;
}

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const props = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const required = new Set((schema.required as string[]) ?? []);

  if (!props) return z.object({});

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(props)) {
    let field: z.ZodTypeAny = z.unknown();
    switch (value.type as string) {
      case "string":
        field = z.string();
        break;
      case "number":
      case "integer":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "array":
        field = z.array(z.unknown());
        break;
      case "object":
        field = z.record(z.string(), z.unknown());
        break;
    }
    if (value.description) field = field.describe(value.description as string);
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }

  return z.object(shape);
}
