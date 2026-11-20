/**
 * The machine the UI is showing for chat and for images (from the machines
 * store). Model-management requests send it as X-LLMUI-Machine, and the server
 * refuses them with 409 "machine_changed" if requests now go elsewhere. That
 * way an install/delete/unload never lands on a machine the page didn't show.
 */

const pinned = { chat: null, image: null };
let onStale = () => {};

export function setPinnedMachines({ chat, image }) {
  pinned.chat = chat || null;
  pinned.image = image || null;
}

/** { "X-LLMUI-Machine": id } for `kind` ("chat" | "image"), or {} before the first status. */
export function pinHeader(kind) {
  return pinned[kind] ? { "X-LLMUI-Machine": pinned[kind] } : {};
}

/** Called by the machines store: what to do when the server says the machine changed. */
export function setOnMachineChanged(fn) {
  onStale = fn;
}

/** True (and refreshes the machine status) if a failed response's body says the machine changed. */
export function checkMachineChanged(status, body) {
  if (status === 409 && body?.code === "machine_changed") {
    onStale();
    return true;
  }
  return false;
}
