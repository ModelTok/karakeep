import { useState } from "react";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBasalRateMutation } from "@/lib/basal/bookmarkState";
import { useTranslation } from "@/lib/i18n/client";
import { ListChecks, Pencil, Trash2 } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";

import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { useUpdateBookmark } from "@karakeep/shared-react/hooks/bookmarks";

import BasalBookmarkControls from "../bookmarks/BasalBookmarkControls";
import { EditBookmarkDialog } from "../bookmarks/EditBookmarkDialog";
import { useManageListsModal } from "../bookmarks/ManageListsModal";
import { ArchivedActionIcon, FavouritedActionIcon } from "../bookmarks/icons";

export default function ActionBar({
  bookmark,
  setDeleteDialogOpen,
}: {
  bookmark: ZBookmark;
  setDeleteDialogOpen: (open: boolean) => void;
}) {
  const { t } = useTranslation();

  const [isEditBookmarkDialogOpen, setEditBookmarkDialogOpen] = useState(false);

  const { setOpen: setManageListsModalOpen, content: manageListsModalContent } =
    useManageListsModal(bookmark.id);

  const onError = () => {
    toast({
      variant: "destructive",
      title: "Something went wrong",
      description: "There was a problem with your request.",
    });
  };
  const { mutate: favBookmark, isPending: pendingFav } = useUpdateBookmark({
    onSuccess: () => {
      toast({
        description: "The bookmark has been updated!",
      });
    },
    onError,
  });
  const { mutate: archiveBookmark, isPending: pendingArchive } =
    useUpdateBookmark({
      onSuccess: (resp) => {
        toast({
          description: `The bookmark has been ${resp.archived ? "Archived" : "Un-archived"}!`,
        });
      },
      onError,
    });

  const { mutate: rateBookmark } = useBasalRateMutation({
    onSuccess: () => {
      toast({ description: t("basal.rating.saved") });
    },
  });
  // Digits 1/2/3 rate the previewed bookmark. Verified free in
  // useBookmarkKeyboardNavigation (it binds no digits). Ignored in form fields.
  const ratingHotkeyOptions = {
    preventDefault: true,
    enableOnFormTags: false,
    enableOnContentEditable: false,
  } as const;
  useHotkeys(
    "1",
    () => rateBookmark({ bookmarkId: bookmark.id, rating: 0 }),
    ratingHotkeyOptions,
    [bookmark.id],
  );
  useHotkeys(
    "2",
    () => rateBookmark({ bookmarkId: bookmark.id, rating: 1 }),
    ratingHotkeyOptions,
    [bookmark.id],
  );
  useHotkeys(
    "3",
    () => rateBookmark({ bookmarkId: bookmark.id, rating: 2 }),
    ratingHotkeyOptions,
    [bookmark.id],
  );

  return (
    <div className="flex flex-wrap items-center justify-center gap-3 text-muted-foreground">
      <BasalBookmarkControls bookmarkId={bookmark.id} showLabel />
      <Tooltip delayDuration={0}>
        <EditBookmarkDialog
          bookmark={bookmark}
          open={isEditBookmarkDialogOpen}
          setOpen={setEditBookmarkDialogOpen}
        />

        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="none"
            className="size-8 rounded-md"
            onClick={() => {
              setEditBookmarkDialogOpen(true);
            }}
          >
            <Pencil size={18} strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("actions.edit")}</TooltipContent>
      </Tooltip>
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="none"
            className="size-8 rounded-md"
            onClick={() => {
              setManageListsModalOpen(true);
            }}
          >
            <ListChecks size={18} strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("actions.manage_lists")}
        </TooltipContent>
      </Tooltip>
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <ActionButton
            variant="ghost"
            size="none"
            className="size-8 rounded-md"
            loading={pendingFav}
            onClick={() => {
              favBookmark({
                bookmarkId: bookmark.id,
                favourited: !bookmark.favourited,
              });
            }}
          >
            <FavouritedActionIcon
              favourited={bookmark.favourited}
              size={18}
              strokeWidth={1.5}
            />
          </ActionButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {bookmark.favourited
            ? t("actions.unfavorite")
            : t("actions.favorite")}
        </TooltipContent>
      </Tooltip>
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <ActionButton
            variant="ghost"
            size="none"
            loading={pendingArchive}
            className="size-8 rounded-md"
            onClick={() => {
              archiveBookmark({
                bookmarkId: bookmark.id,
                archived: !bookmark.archived,
              });
            }}
          >
            <ArchivedActionIcon
              archived={bookmark.archived}
              size={18}
              strokeWidth={1.5}
            />
          </ActionButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {bookmark.archived ? t("actions.unarchive") : t("actions.archive")}
        </TooltipContent>
      </Tooltip>
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <Button
            className="size-8 rounded-md"
            variant="ghost"
            size="none"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 size={18} strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("actions.delete")}</TooltipContent>
      </Tooltip>
      {manageListsModalContent}
    </div>
  );
}
