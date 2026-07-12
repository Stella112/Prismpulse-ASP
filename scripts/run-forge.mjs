import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const forge =
  process.env.FORGE_BIN ??
  (process.platform === "win32"
    ? join(homedir(), ".foundry", "bin", "forge.exe")
    : "forge");

const result = spawnSync(forge, process.argv.slice(2), {
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(`Unable to run Foundry at ${forge}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
