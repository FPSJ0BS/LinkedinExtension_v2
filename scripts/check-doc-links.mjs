import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const markdownFiles = ["AGENTS.md", "CLAUDE.md", "README.md"];

async function collectMarkdown(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) await collectMarkdown(path.join(directory, entry.name), relative);
    else if (entry.name.endsWith(".md")) markdownFiles.push(path.join("docs", relative));
  }
}

await collectMarkdown(path.join(root, "docs"));

const broken = [];
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

for (const relativeFile of markdownFiles) {
  const absoluteFile = path.join(root, relativeFile);
  const source = await readFile(absoluteFile, "utf8");

  for (const match of source.matchAll(linkPattern)) {
    const rawTarget = match[1].trim();
    if (!rawTarget || /^(?:https?:|mailto:|#)/i.test(rawTarget)) continue;

    const target = decodeURIComponent(rawTarget.split("#", 1)[0]);
    const absoluteTarget = path.resolve(path.dirname(absoluteFile), target);
    try {
      await access(absoluteTarget);
    } catch {
      broken.push(`${relativeFile}: ${rawTarget}`);
    }
  }
}

if (broken.length) {
  console.error(`Broken local Markdown links:\n${broken.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}

console.log(`Checked local links in ${markdownFiles.length} Markdown files.`);
