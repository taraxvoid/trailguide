const HTML_BLOCK_TAGS = /<\/(p|div|li|br|ul|ol|h[1-6])\s*>|<(br)\s*\/?>/gi;

export function stripHtml(html: string): string {
  return html
    .replace(HTML_BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n")
    .trim();
}
