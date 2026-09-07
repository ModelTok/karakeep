"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ActionButton } from "@/components/ui/action-button";
import ActionConfirmingDialog from "@/components/ui/action-confirming-dialog";
import { toast } from "@/components/ui/sonner";
import { useTranslation } from "@/lib/i18n/client";
import { useKeyboardNavigationStore } from "@/lib/store/useKeyboardNavigationStore";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";

import { useTRPC } from "@karakeep/shared-react/trpc";
import type { ZFeed } from "@karakeep/shared/types/feeds";

/**
 * Delete/Backspace hotkey for the feed detail page
 * (app/dashboard/feeds/[feedId]). Only fires while the bookmarks grid
 * keyboard navigation is inactive, so it never collides with the grid's
 * own delete hotkey (# / Delete on a focused or selected bookmark):
 * when the user is navigating the grid, Delete deletes bookmarks; when
 * nothing is focused, Delete deletes the feed itself.
 */
export function FeedDeleteHotkey({ feed }: { feed: ZFeed }) {
  const api = useTRPC();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const router = useRouter();
  const isNavigating = useKeyboardNavigationStore(
    (state) => state.isNavigating,
  );
  const isPreviewModalOpen = useKeyboardNavigationStore(
    (state) => state.isPreviewModalOpen,
  );
  const [open, setOpen] = useState(false);

  const { mutate: deleteFeed, isPending: isDeleting } = useMutation(
    api.feeds.delete.mutationOptions({
      onSuccess: () => {
        toast({
          description: "Feed has been deleted!",
        });
        queryClient.invalidateQueries(api.feeds.list.pathFilter());
        router.push("/dashboard/feeds");
      },
    }),
  );

  useHotkeys(
    "delete,backspace",
    () => setOpen(true),
    {
      enabled: !isNavigating && !isPreviewModalOpen && !open,
      preventDefault: true,
    },
    [isNavigating, isPreviewModalOpen, open],
  );

  return (
    <ActionConfirmingDialog
      title={`Delete Feed "${feed.name}"?`}
      description={`Are you sure you want to delete the feed "${feed.name}"?`}
      open={open}
      setOpen={setOpen}
      actionButton={() => (
        <ActionButton
          loading={isDeleting}
          variant="destructive"
          onClick={() => deleteFeed({ feedId: feed.id })}
          className="items-center"
          type="button"
        >
          <Trash2 className="mr-2 size-4" />
          {t("actions.delete")}
        </ActionButton>
      )}
    />
  );
}
