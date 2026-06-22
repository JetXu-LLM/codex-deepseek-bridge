// Tiny, dependency-free helpers that give the CLI clear structure on a real
// terminal while staying plain ASCII when output is piped or redirected, so
// logs and CI captures stay clean. Color is opt-out via NO_COLOR / DSCB_NO_COLOR
// and only ever used on a TTY.

const CODES = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
};

export function colorEnabled(stream, env = process.env) {
  if (env && env.DSCB_NO_COLOR === "1") {
    return false;
  }
  if (env && (env.NO_COLOR ?? "") !== "") {
    return false;
  }
  if (env && env.FORCE_COLOR && env.FORCE_COLOR !== "0") {
    return true;
  }
  return Boolean(stream && stream.isTTY);
}

// Break a string into lines no wider than max, on word boundaries.
export function wrapText(text, max) {
  const width = Math.max(1, Number(max) || 1);
  const out = [];
  for (const paragraph of String(text).split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (!line.length) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

export function createFormatter({ stream = process.stdout, env = process.env } = {}) {
  const color = colorEnabled(stream, env);
  const columns = (stream && Number(stream.columns)) || 0;
  const width = Math.min(Math.max(columns || 72, 48), 76);

  const paint = (text, ...names) => {
    if (!color || !names.length) {
      return text;
    }
    const open = names.map((name) => CODES[name] || "").join("");
    return `${open}${text}${CODES.reset}`;
  };

  const rule = (char = "=") => char.repeat(width);

  // A framed banner for the top of a command's output.
  const title = (text) =>
    [paint(rule("="), "dim"), paint(`  ${text}`, "bold"), paint(rule("="), "dim")].join("\n");

  // A labeled section header with the items indented under it.
  const section = (label, lines) => {
    const rows = [].concat(lines).filter((line) => line !== undefined && line !== null);
    return [paint(label, "bold"), ...rows.map((line) => `  ${line}`)].join("\n");
  };

  // Frame a block of lines so an important message is hard to miss. The border
  // carries the tone (red for action, yellow for warning, green for done).
  const box = (lines, { tone = "cyan" } = {}) => {
    const inner = width - 4;
    const body = [];
    for (const raw of [].concat(lines)) {
      if (raw === "") {
        body.push("");
        continue;
      }
      if (raw.length <= inner) {
        body.push(raw);
        continue;
      }
      for (const line of wrapText(raw, inner)) {
        body.push(line);
      }
    }
    const border = paint(`+${"=".repeat(width - 2)}+`, tone, "bold");
    const rows = body.map((line) => {
      const padded = line + " ".repeat(Math.max(0, inner - line.length));
      const edge = paint("|", tone, "bold");
      return `${edge} ${padded} ${edge}`;
    });
    return [border, ...rows, border].join("\n");
  };

  const label = {
    ok: (text) => paint(text, "green"),
    warn: (text) => paint(text, "yellow"),
    bad: (text) => paint(text, "red"),
    info: (text) => paint(text, "cyan"),
    dim: (text) => paint(text, "dim"),
    bold: (text) => paint(text, "bold"),
  };

  return { color, width, paint, rule, title, section, box, label };
}
