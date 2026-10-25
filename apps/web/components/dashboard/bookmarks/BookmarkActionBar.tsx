"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Maximize2 } from "lucide-react";

import type { ZBookmark } from "@karakeep/shared/types/bookmarks";

import BasalBookmarkControls from "./BasalBookmarkControls";
import BookmarkOptions from "./BookmarkOptions";
import { FavouritedActionIcon } from "./icons";

export default function BookmarkActionBar({
  bookmark,
  favouritedClassName,
  showBasal = true,
}: {
  bookmark: ZBookmark;
  favouritedClassName?: string;
  // GridView renders the basal controls in its own row; avoid a duplicate.
  showBasal?: boolean;
}) {
  return (
    <div className="flex items-center text-gray-500">
      {showBasal && <BasalBookmarkControls bookmarkId={bookmark.id} />}
      {bookmark.favourited && (
        <FavouritedActionIcon
          className={cn("m-1 size-8 rounded p-1", favouritedClassName)}
          favourited
        />
      )}
      <Link
        href={`/dashboard/preview/${bookmark.id}`}
        className={cn(buttonVariants({ variant: "ghost" }), "px-2")}
      >
        <Maximize2 size={16} />
      </Link>
      <BookmarkOptions bookmark={bookmark} />
    </div>
  );
}
