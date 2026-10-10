const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");

const dataDir = path.join(__dirname, "../../data");
let snapshots;

test.before(async () => {
  const names = (await fs.readdir(dataDir)).filter((name) => name.endsWith(".json"));
  snapshots = new Map();
  for (const name of names) snapshots.set(name, await fs.readFile(path.join(dataDir, name)));
});

test.after(async () => {
  if (!snapshots) return;
  const currentNames = (await fs.readdir(dataDir)).filter((name) => name.endsWith(".json"));
  for (const name of currentNames) {
    if (!snapshots.has(name)) await fs.rm(path.join(dataDir, name), { force: true });
  }
  for (const [name, contents] of snapshots) await fs.writeFile(path.join(dataDir, name), contents);
});
