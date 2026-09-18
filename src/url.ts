const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_click_id",
  "fbclid",
  "gclid",
  "msclkid",
  "mc_eid",
  "twclid",
  "li_fat_id",
  "oly_anon_id",
  "oly_enc_id",
  "ref",
  "ref_src",
  "ref_url",
]);

export function stripTrackingParams(url: string): string {
  try {
    const parsed = new URL(url);
    for (const param of TRACKING_PARAMS) {
      parsed.searchParams.delete(param);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
