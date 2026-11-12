// Dev server for the harness page. Run with the web app's vite (it has the dependencies):
//   cd web && npx vite --config ../tools/maps3d/harness/vite.config.mjs
// (make harness-serve). Serves page/ and, under /data/<name>/, a dataset folder: a reference
// dataset from harness/data/<name>, otherwise the overview from maps/3d/<name>.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const roots = [path.join(here, "data"), path.join(repo, "maps", "3d")];

const datasets = {
  name: "maps3d-datasets",
  configureServer(server) {
    server.middlewares.use("/data", (req, res, next) => {
      const parts = decodeURIComponent((req.url ?? "").split("?")[0]).split("/").filter(Boolean);
      if (parts.length !== 2 || parts.some((p) => p.startsWith(".") || p.includes("\\"))) return next();
      const file = roots.map((root) => path.join(root, ...parts)).find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
      if (!file) {
        res.statusCode = 404;
        return res.end(`no dataset file ${parts.join("/")}`);
      }
      res.setHeader("Content-Length", fs.statSync(file).size);
      res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : file.endsWith(".png") ? "image/png" : "application/octet-stream");
      fs.createReadStream(file).pipe(res);
    });
  },
};

export default {
  root: path.join(here, "page"),
  plugins: [datasets],
  server: { port: 5174, strictPort: true, fs: { allow: [repo] } },
};
