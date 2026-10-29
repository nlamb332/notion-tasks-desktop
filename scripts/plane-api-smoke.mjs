import fs from "node:fs";

function localEnv() {
  const result = {};
  try {
    for (const line of fs.readFileSync(".env.plane.local", "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !match[2].startsWith("#")) result[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // The local file is optional; environment variables may provide the same values.
  }
  return result;
}

const fileEnv = localEnv();
const apiKey = process.env.PLANE_API_KEY || fileEnv.PLANE_API_KEY;
const baseUrl = (process.env.PLANE_BASE_URL || fileEnv.PLANE_BASE_URL || "https://api.plane.so/api/v1").replace(/\/+$/, "");
const workspace = process.env.PLANE_WORKSPACE_SLUG || fileEnv.PLANE_WORKSPACE_SLUG;
const project = process.env.PLANE_PROJECT_ID || fileEnv.PLANE_PROJECT_ID;

if (!apiKey || !workspace) {
  console.log("Plane smoke skipped: set PLANE_API_KEY and PLANE_WORKSPACE_SLUG in .env.plane.local or the environment.");
  process.exit(0);
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(20_000), headers: { "X-API-Key": apiKey, Accept: "application/json" } });
  if (!response.ok) throw new Error(`Plane read failed (${response.status})`);
  return response.json();
}

const projects = await get(`/workspaces/${encodeURIComponent(workspace)}/projects/?per_page=1`);
const count = Array.isArray(projects) ? projects.length : Array.isArray(projects?.results) ? projects.results.length : 0;
console.log(`Plane read-only smoke passed: workspace responded (${count} project result${count === 1 ? "" : "s"}).`);
if (project) {
  const states = await get(`/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(project)}/states/?per_page=1`);
  const stateCount = Array.isArray(states) ? states.length : Array.isArray(states?.results) ? states.results.length : 0;
  console.log(`Plane state read passed (${stateCount} result${stateCount === 1 ? "" : "s"}).`);
}
