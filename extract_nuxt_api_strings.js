const fs = require("fs");
const path = require("path");

const dir = path.join("_pisofi_site_copy", "pisofi-site-copy", "assets", "scripts");
const interesting = /^(https?:\/\/|\/|api$|devices|devices\/|licenses|licenses\/|credits|credits\/|tokens|tokens\/|super\/)/i;
const out = new Set();

for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".js"))) {
  const source = fs.readFileSync(path.join(dir, file), "utf8");
  const stringLiteral = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let match;
  while ((match = stringLiteral.exec(source))) {
    const value = (match[1] ?? match[2] ?? "").replace(/\\\//g, "/");
    if (interesting.test(value) && value.length < 160 && !/[{};]/.test(value)) {
      out.add(value);
    }
  }
}

console.log([...out].sort().join("\n"));
