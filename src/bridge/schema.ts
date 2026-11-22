/**
 * Convert MCP tool schemas into the flat JSON Schema shape that hosted model
 * APIs accept.
 *
 * The problem: win_mcp's discriminated tools (`git_workflow`,
 * `manage_text_transfer`, `workspace_context`, the platform adapters, …) are
 * `oneOf` unions keyed on an `action` const. OpenAI-style function calling does
 * not support `oneOf`, and sending it produces either a schema error or a model
 * that never picks the tool.
 *
 * The fix: flatten each union member into one shared property bag, turning the
 * discriminator into an `enum` of its allowed values. The model then emits
 * `{action: "status", path: "..."}`, which the real server validates again —
 * this conversion is for the model's benefit only and never weakens the
 * server's own checks.
 */

import type { McpToolDefinition } from "./mcpClient.js";

export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

type JsonSchema = Record<string, unknown>;

function asObject(value: unknown): JsonSchema | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchema)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Collect `const`/`enum` values a discriminator property may take. */
function collectValues(branches: JsonSchema[], property: string): unknown[] {
  const values: unknown[] = [];
  for (const branch of branches) {
    const props = asObject(branch.properties);
    const prop = props ? asObject(props[property]) : undefined;
    if (!prop) continue;
    if (prop.const !== undefined) values.push(prop.const);
    for (const value of asArray(prop.enum)) values.push(value);
  }
  return [...new Set(values)];
}

/** Pick the property whose values are all string consts and that most branches define. */
function findDiscriminator(branches: JsonSchema[]): string | undefined {
  const counts = new Map<string, number>();
  for (const branch of branches) {
    const props = asObject(branch.properties);
    if (!props) continue;
    for (const [name, raw] of Object.entries(props)) {
      const prop = asObject(raw);
      if (!prop) continue;
      if (prop.const !== undefined || Array.isArray(prop.enum)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [name, count] of counts) {
    // `action` wins ties: it is the convention across this server.
    if (count > bestCount || (count === bestCount && name === "action")) {
      best = name;
      bestCount = count;
    }
  }
  // Only treat it as a discriminator when it covers every branch.
  return bestCount === branches.length ? best : undefined;
}

/**
 * Flatten one union branch into the shared bag.
 *
 * Branch-specific properties are merged; a property is only required when every
 * branch requires it, because requiring more would produce calls the model
 * cannot satisfy for other actions.
 */
function flattenUnion(schema: JsonSchema, branches: JsonSchema[]): JsonSchema {
  const merged: Record<string, JsonSchema> = {};
  const requiredCounts = new Map<string, number>();

  for (const branch of branches) {
    const props = asObject(branch.properties) ?? {};
    for (const [name, raw] of Object.entries(props)) {
      const prop = asObject(raw);
      if (!prop) continue;
      // Drop branch-local const/enum on the discriminator; it is widened below.
      merged[name] = merged[name] ? { ...merged[name], ...prop } : { ...prop };
    }
    for (const name of asArray(branch.required)) {
      if (typeof name === "string") {
        requiredCounts.set(name, (requiredCounts.get(name) ?? 0) + 1);
      }
    }
  }

  const discriminator = findDiscriminator(branches);
  if (discriminator) {
    const values = collectValues(branches, discriminator);
    merged[discriminator] = {
      type: "string",
      enum: values,
      description:
        `Which operation to run. Allowed: ${values.join(", ")}. ` +
        "Different actions accept different other fields; supply what the action needs.",
    };
  }

  const required = [...requiredCounts.entries()]
    .filter(([, count]) => count === branches.length)
    .map(([name]) => name);

  const parameters: JsonSchema = {
    type: "object",
    properties: merged,
    additionalProperties: false,
  };
  if (required.length > 0) parameters.required = required;
  if (discriminator && !required.includes(discriminator)) {
    parameters.required = [...(parameters.required as string[] ?? []), discriminator];
  }
  return parameters;
}

/**
 * Convert one MCP schema into flat JSON Schema parameters.
 *
 * Exported for tests: the union flattening is the part most likely to regress.
 */
export function toFlatParameters(schema: JsonSchema | undefined): JsonSchema {
  if (!schema) return { type: "object", properties: {}, additionalProperties: false };

  // Unwrap the outer object around a union: `{type:"object", oneOf:[...]}`.
  const unions = [
    ...asArray(schema.oneOf),
    ...asArray(schema.anyOf),
  ].map(asObject).filter((branch): branch is JsonSchema => Boolean(branch));

  if (unions.length > 0) return flattenUnion(schema, unions);

  const properties = asObject(schema.properties) ?? {};
  const cleaned: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(properties)) {
    const prop = asObject(raw);
    if (!prop) continue;
    // Nested unions inside a property are widened to a permissive object; the
    // server still validates the real shape, so this only affects prompting.
    cleaned[name] = prop.oneOf || prop.anyOf ? { type: "object" } : prop;
  }

  const parameters: JsonSchema = {
    type: "object",
    properties: cleaned,
    additionalProperties: false,
  };
  const required = asArray(schema.required).filter((name) => typeof name === "string");
  if (required.length > 0) parameters.required = required;
  return parameters;
}

/** Tool names are already API-safe; keep a guard for future additions. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/**
 * Build the `tools` array for a hosted model API.
 *
 * `maxDescription` trims descriptions so a 43-tool inventory fits a small
 * context budget; the server's descriptions are long.
 */
export function toFunctionDefinitions(
  tools: McpToolDefinition[],
  options: { maxDescription?: number } = {},
): FunctionDefinition[] {
  const max = options.maxDescription ?? 300;
  return tools.map((tool) => {
    const description = (tool.description ?? tool.name).trim();
    return {
      name: sanitizeName(tool.name),
      description:
        description.length > max ? `${description.slice(0, max - 1)}…` : description,
      parameters: toFlatParameters(tool.inputSchema),
    };
  });
}

/** Map a sanitized function name back to the original tool name. */
export function buildNameMap(tools: McpToolDefinition[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools) map.set(sanitizeName(tool.name), tool.name);
  return map;
}
