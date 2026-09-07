"use client";

import { useEffect } from "react";

import { useFullPagePreviewStore } from "@/lib/store/useFullPagePreviewStore";
import type { ZBookmark } from "@karakeep/shared/types/bookmarks";

import BookmarkPreview from "./BookmarkPreview";

/**
 * Client wrapper for the full-page preview route
 * (app/dashboard/preview/[bookmarkId]/page.tsx).
 *
 * On a hard load of /dashboard/preview/<id>, Next.js renders BOTH the
 * full page (children slot) and the intercepting modal
 * (@modal/(.)preview/[bookmarkId]) - two mounted BookmarkPreview
 * instances, each with its own hotkey listeners, list query and
 * position counter. The modal hides itself while this store flag is
 * set, leaving exactly one instance: the modal only ever shows on
 * client-side interception (clicking a card), where the full page
 * never mounts.
 */
export function FullPagePreview({
  bookmarkId,
  initialData,
}: {
  bookmarkId: string;
  initialData: ZBookmark;
}) {
  const setActive = useFullPagePreviewStore((state) => state.setActive);

  useEffect(() => {
    setActive(true);
    return () => setActive(false);
  }, [setActive]);

  return <BookmarkPreview bookmarkId={bookmarkId} initialData={initialData} />;
}
