import { create } from "zustand";

/**
 * The full-screen image preview (ImageViewer, mounted once in App).
 * items: [{ generationId, imageId }] the arrows / swipes move through.
 */
export const useImageViewerStore = create((set) => ({
  items: [],
  index: -1,
  open: (items, index = 0) => {
    if (!items?.length) return;
    set({ items, index: Math.min(Math.max(index, 0), items.length - 1) });
  },
  close: () => set({ items: [], index: -1 }),
  go: (delta) =>
    set((s) => {
      const next = s.index + delta;
      return next < 0 || next >= s.items.length ? s : { index: next };
    }),
}));

/** Every image of the loaded history generations, newest first, in position order. */
export function historyItems(generations) {
  return (generations || []).flatMap((g) =>
    (g.image_ids?.length ? g.image_ids : g.first_image_id ? [g.first_image_id] : []).map((imageId) => ({
      generationId: g.id,
      imageId,
    }))
  );
}

/**
 * Open the preview on one image, moving through the loaded history when it's
 * part of it, else through `fallback` (e.g. the current generation's images).
 */
export function openInHistory(generations, generationId, imageId, fallback = []) {
  const items = historyItems(generations);
  let index = items.findIndex((it) => it.generationId === generationId && it.imageId === imageId);
  if (index >= 0) return useImageViewerStore.getState().open(items, index);
  index = fallback.findIndex((it) => it.generationId === generationId && it.imageId === imageId);
  useImageViewerStore.getState().open(fallback.length ? fallback : [{ generationId, imageId }], Math.max(index, 0));
}
