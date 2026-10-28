import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/**
 * `text` whole when it fits in `cols` columns, else cut by whole columns to end in `ellipsis`;
 * "" for `cols` of 0 or less, and no ellipsis when the ellipsis alone fills `cols`. Never wider
 * than `cols`. Adds no escape: unlike `truncateToWidth`, whose SGR reset around the ellipsis
 * ends the colour or background the text is drawn in, and puts escapes into a TERM=dumb row.
 */
export function fitToWidth(
  text: string,
  cols: number,
  ellipsis: string,
): string {
  if (cols <= 0) return "";
  if (visibleWidth(text) <= cols) return text;
  const room = cols - visibleWidth(ellipsis);
  return room <= 0
    ? sliceByColumn(text, 0, cols, true)
    : `${sliceByColumn(text, 0, room, true)}${ellipsis}`;
}
