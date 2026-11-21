export type SiteLanguage = "ca" | "en";
export type BilingualText = Readonly<Record<string, readonly [ca: string, en: string]>>;

export function siteLanguage(url?: string): SiteLanguage {
  const query = url?.split("?", 2)[1];
  return new URLSearchParams(query).get("lang") === "en" ? "en" : "ca";
}

export function localizeMarkup(template: string, copy: BilingualText, language: SiteLanguage): string {
  return template.replaceAll("{{language}}", language).replace(/\{\{copy\.(\w+)\}\}/g, (_, key: string) => {
    const message = copy[key];
    if (!message) throw new Error(`Missing page copy for ${key}`);
    return message[language === "ca" ? 0 : 1].replace(/[&<>"']/g, character =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  });
}
