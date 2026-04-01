function setTerminalTitle(title) {
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) {
    return;
  }

  process.title = normalizedTitle;

  if (process.stdout.isTTY) {
    process.stdout.write(`\u001b]0;${normalizedTitle}\u0007`);
  }
}

setTerminalTitle("codicodi-server");

await import("../server/src/index.js");
