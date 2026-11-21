import { App } from "@modelcontextprotocol/ext-apps";

const app = window.parent === window ? null : new App({ name: "Relocat Start talking", version: "2.0.0" });
const link = document.querySelector<HTMLAnchorElement>("a.launch");
const help = document.querySelector<HTMLElement>("#launch-help");

link?.addEventListener("click", async event => {
  const openai = (window as Window & { openai?: {
    openExternal?: (input: { href: string; redirectUrl: boolean }) => unknown;
  } }).openai;
  const hostOpensLinks = app?.getHostCapabilities()?.openLinks;
  if (!hostOpensLinks && typeof openai?.openExternal !== "function") return;
  event.preventDefault();
  try {
    if (hostOpensLinks && app) {
      const result = await app.openLink({ url: link.href });
      if (result.isError) throw new Error("The host could not open the voice interviewer");
    } else {
      await openai?.openExternal?.({ href: link.href, redirectUrl: false });
    }
  } catch {
    if (help) help.hidden = false;
  }
});

void app?.connect().catch(() => { if (help) help.hidden = false; });
