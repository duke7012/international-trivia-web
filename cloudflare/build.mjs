// Gathers everything Cloudflare serves as static files into one folder:
// the pages and scripts, the shared rule modules the pages import, and the demo set's media.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".cloudflare", "assets");
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, "public"), out, { recursive: true });
fs.cpSync(path.join(root, "shared"), path.join(out, "shared"), { recursive: true });
fs.cpSync(path.join(root, "demo", "seed", "media"), path.join(out, "seed-media"), { recursive: true });
fs.writeFileSync(path.join(out, "_headers"), "/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: SAMEORIGIN\n  Referrer-Policy: no-referrer\n");
console.log(`Static files ready in ${path.relative(root, out)}`);
