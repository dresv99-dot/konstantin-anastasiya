const { spawnSync } = require("node:child_process");
const files = [
  "script.js",
  "admin.js",
  "worker/index.js"
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

process.stdout.write("Синтаксис JavaScript проверен.\n");
