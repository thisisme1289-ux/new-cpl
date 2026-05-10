import express from "express";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const PORT = process.env.PORT || 4173;
const distPath = resolve("dist");
const indexPath = join(distPath, "index.html");

if (!existsSync(indexPath)) {
  console.error("Missing dist/index.html. Run `npm run build` before starting the frontend server.");
  process.exit(1);
}

const app = express();

app.use(express.static(distPath, {
  extensions: ["html"],
  maxAge: "1h",
}));

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    service: "cpl-frontend",
    serving: "dist",
  });
});

app.use((_request, response) => {
  response.sendFile(indexPath);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CPL frontend server running on port ${PORT}`);
});
