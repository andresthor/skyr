import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/**
 * `text` whole when it fits in `cols` columns, else cut by whole columns to end in `ellipsis`,
 * with no escape added: unlike `truncateToWidth`, whose SGR reset around the ellipsis ends the
 * colour or background the text is drawn in, and puts escapes into a TERM=dumb row.
 */
export function fitToWidth(
  text: string,
  cols: number,
  ellipsis: string,
): string {
  return visibleWidth(text) <= cols
    ? text
    : `${sliceByColumn(text, 0, cols - visibleWidth(ellipsis), true)}${ellipsis}`;
}
