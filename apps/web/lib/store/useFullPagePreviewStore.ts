import { create } from "zustand";

interface FullPagePreviewState {
  active: boolean;
  setActive: (active: boolean) => void;
}

export const useFullPagePreviewStore = create<FullPagePreviewState>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}));
