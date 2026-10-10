const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = path.join(__dirname, "../../data");

async function read(filename, fallback) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const filepath = path.join(DATA_DIR, filename);

  try {
    return JSON.parse(await fs.readFile(filepath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      await write(filename, fallback);
      return fallback;
    }
    throw error;
  }
}

async function write(filename, value) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, filename),
    JSON.stringify(value, null, 2),
    "utf8"
  );
}

module.exports = { read, write };
