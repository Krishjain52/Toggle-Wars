/**
 * Recovery tool: ship a named fighter from a run's battle flags (archived or
 * not) to the production flag. Usage: tsx src/tools/ship-champion.ts "<fighter name>"
 */
import * as fs from "../flagsmith/admin.js";
import { PRODUCTION_FLAG } from "../evolve.js";
import { parseVariant, type VariantSpec } from "../variant.js";

const wanted = process.argv[2];
if (!wanted) throw new Error('usage: ship-champion.ts "<fighter name>"');

const project = await fs.projectId();
const list = async (archived: boolean) =>
  JSON.parse(await fs.cli(["api", `api/v1/projects/${project}/features/?is_archived=${archived}&page_size=200`])).results as {
    name: string;
    initial_value: string | null;
    multivariate_options: { string_value: string | null }[];
  }[];

let found: VariantSpec | null = null;
for (const f of [...(await list(false)), ...(await list(true))]) {
  if (!f.name.startsWith("arena_")) continue;
  const candidates = [f.initial_value, ...f.multivariate_options.map((o) => o.string_value)];
  found = candidates.map((c) => parseVariant(c)).find((v) => v?.name === wanted) ?? null;
  if (found) break;
}
if (!found) throw new Error(`No fighter named "${wanted}" in any arena flag`);
await fs.shipFlagValue(PRODUCTION_FLAG, JSON.stringify(found), "Live landing page, owned by Toggle Wars");
console.log(`Shipped "${found.name}" to ${PRODUCTION_FLAG}: ${found.headline}`);
