import { notFound } from "next/navigation";
import { FullPagePreview } from "@/components/dashboard/preview/FullPagePreview";
import { api } from "@/server/api/client";
import { TRPCError } from "@trpc/server";

export default async function BookmarkPreviewPage(props: {
  params: Promise<{ bookmarkId: string }>;
}) {
  const params = await props.params;
  let bookmark;
  try {
    bookmark = await api.bookmarks.getBookmark({
      bookmarkId: params.bookmarkId,
    });
  } catch (e) {
    if (e instanceof TRPCError) {
      if (e.code === "NOT_FOUND") {
        notFound();
      }
    }
    throw e;
  }

  return (
    <div className="h-[calc(100dvh-theme(spacing.16)-theme(spacing.8))] overflow-hidden">
      <FullPagePreview bookmarkId={bookmark.id} initialData={bookmark} />
    </div>
  );
}
