export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** Run an action from a button and flash its outcome on the label. */
export function flashButton(button: HTMLElement, action: () => Promise<boolean>): void {
  button.addEventListener("click", async () => {
    const old = button.textContent;
    button.textContent = (await action()) ? "Copied" : "Copy failed";
    setTimeout(() => (button.textContent = old), 1200);
  });
}
