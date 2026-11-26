import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The published IMD paid-request schemas: https://api.imd.fun/openapi.json, saved 2026-11-26.
 * A small validator covering the JSON Schema keywords these schemas use (type, required,
 * properties, additionalProperties:false, pattern, const, enum, minItems, maxProperties, oneOf, $ref).
 */
export const OPENAPI = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/imd-openapi.2026-11-26.json"), "utf8"));
const resolve = (s: any): any => (s?.$ref ? resolve(s.$ref.replace(/^#\//, "").split("/").reduce((o: any, k: string) => o[k], OPENAPI)) : s);
const typeOk = (t: string, v: unknown) => t === "null" ? v === null : t === "array" ? Array.isArray(v) : t === "integer" ? Number.isInteger(v) : t === "object" ? !!v && typeof v === "object" && !Array.isArray(v) : typeof v === t;

export function validate(schema: any, v: unknown, at = "$"): string[] {
  const s = resolve(schema); if (!s) return [];
  const out: string[] = [];
  if (s.oneOf) { const ok = s.oneOf.filter((x: any) => validate(x, v, at).length === 0).length; return ok === 1 ? [] : [`${at}: matches ${ok} of oneOf`]; }
  if (s.type) { const ts = Array.isArray(s.type) ? s.type : [s.type]; if (!ts.some((t: string) => typeOk(t, v))) return [`${at}: expected ${ts.join("|")}`]; }
  if ("const" in s && v !== s.const) out.push(`${at}: expected const ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) out.push(`${at}: not in enum`);
  if (s.pattern && typeof v === "string" && !new RegExp(s.pattern).test(v)) out.push(`${at}: ${JSON.stringify(v)} fails ${s.pattern}`);
  if (s.minItems && Array.isArray(v) && v.length < s.minItems) out.push(`${at}: fewer than ${s.minItems} items`);
  if (Array.isArray(v) && s.items) v.forEach((x, i) => out.push(...validate(s.items, x, `${at}[${i}]`)));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (s.maxProperties != null && Object.keys(o).length > s.maxProperties) out.push(`${at}: too many properties`);
    for (const k of s.required ?? []) if (!(k in o)) out.push(`${at}: missing ${k}`);
    for (const [k, x] of Object.entries(o)) {
      if (s.properties?.[k]) out.push(...validate(s.properties[k], x, `${at}.${k}`));
      else if (s.additionalProperties === false) out.push(`${at}: unknown property ${k}`);
    }
  }
  return out;
}
export const schemas = {
  quoteBody: OPENAPI.paths["/requests/quote"].post.requestBody.content["application/json"].schema,
  quoteResponse: OPENAPI.paths["/requests/quote"].post.responses["201"].content["application/json"].schema,
  submitBody: OPENAPI.paths["/requests/{id}/submit"].post.requestBody.content["application/json"].schema,
  challenge: { $ref: "#/components/schemas/Challenge" },
  status: { $ref: "#/components/schemas/Status" },
};
