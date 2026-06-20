export function writeSse(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function parseSseFrames(buffer) {
  const frames = [];
  let start = 0;
  while (true) {
    const index = buffer.indexOf("\n\n", start);
    if (index === -1) {
      break;
    }
    frames.push(buffer.slice(start, index));
    start = index + 2;
  }
  return { frames, rest: buffer.slice(start) };
}

export function dataFromSseFrame(frame) {
  return frame
    .split(/\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}
