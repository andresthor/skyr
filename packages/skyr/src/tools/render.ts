/** The text message renderer shells still use. */
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { sanitize } from "../ui/text.js";

/** A message's text, one sanitized line per line. */
function messageLines(
  message: Pick<Parameters<MessageRenderer>[0], "content">,
): string[] {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  return text.split("\n").map(sanitize);
}

/**
 * Draws a message as its text, one sanitized line per line, cut to `previewLines` until
 * expanded. Its text carries a model's or a process's output, which Pi's default renderer would
 * draw as markdown with its escape sequences intact.
 */
export function textMessageRenderer(previewLines: number): MessageRenderer {
  return (message, { expanded, outputPad }, theme) => {
    const lines = messageLines(message);
    const shown = expanded ? lines : lines.slice(0, previewLines);
    const hidden = lines.length - shown.length;
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(
      new Text(
        [
          ...shown,
          ...(hidden > 0 ? [theme.fg("muted", `… ${hidden} more lines`)] : []),
        ].join("\n"),
        0,
        0,
      ),
    );
    return box;
  };
}
