"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import BookmarkPreview from "@/components/dashboard/preview/BookmarkPreview";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { useFullPagePreviewStore } from "@/lib/store/useFullPagePreviewStore";

export default function BookmarkPreviewPage(props: {
  params: Promise<{ bookmarkId: string }>;
}) {
  const params = use(props.params);
  const router = useRouter();

  const [open, setOpen] = useState(true);

  const setOpenWithRouter = (value: boolean) => {
    setOpen(value);
    if (!value) {
      router.back();
    }
  };

  // On a hard load of /dashboard/preview/<id> the full-page route also
  // mounts (children slot) - hide this intercepting modal so exactly one
  // BookmarkPreview exists (one hotkey set, one counter, one query).
  // The modal only appears on client-side interception, where the full
  // page is never mounted.
  const fullPagePreviewActive = useFullPagePreviewStore(
    (state) => state.active,
  );

  if (fullPagePreviewActive) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={setOpenWithRouter}>
      <VisuallyHidden>
        <DialogHeader>
          <DialogTitle>Preview</DialogTitle>
        </DialogHeader>
      </VisuallyHidden>
      <DialogContent
        className="h-[90%] max-w-[90%] overflow-hidden rounded-xl p-0"
        hideCloseBtn={true}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <BookmarkPreview
          bookmarkId={params.bookmarkId}
          onClose={() => setOpenWithRouter(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
