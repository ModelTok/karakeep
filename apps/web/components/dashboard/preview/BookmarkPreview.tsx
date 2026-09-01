"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BookmarkTagsEditor } from "@/components/dashboard/bookmarks/BookmarkTagsEditor";
import { FullPageSpinner } from "@/components/ui/full-page-spinner";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSession } from "@/lib/auth/client";
import useRelativeTime from "@/lib/hooks/relative-time";
import { useTranslation } from "@/lib/i18n/client";
import { useKeyboardNavigationStore } from "@/lib/store/useKeyboardNavigationStore";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Building,
  CalendarDays,
  ExternalLink,
  Globe,
  PanelRightClose,
  PanelRightOpen,
  User,
} from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";

import { useTRPC } from "@karakeep/shared-react/trpc";
import type { ZGetBookmarksRequest } from "@karakeep/shared/types/bookmarks";
import { BookmarkTypes, ZBookmark } from "@karakeep/shared/types/bookmarks";
import {
  getBookmarkRefreshInterval,
  getBookmarkTitle,
  getSourceUrl,
  isBookmarkStillCrawling,
} from "@karakeep/shared/utils/bookmarkUtils";

import SummarizeBookmarkArea from "../bookmarks/SummarizeBookmarkArea";
import DeleteBookmarkConfirmationDialog from "../bookmarks/DeleteBookmarkConfirmationDialog";
import ActionBar from "./ActionBar";
import { AssetContentSection } from "./AssetContentSection";
import AttachmentBox from "./AttachmentBox";
import HighlightsBox from "./HighlightsBox";
import LinkContentSection from "./LinkContentSection";
import { NoteEditor } from "./NoteEditor";
import { TextContentSection } from "./TextContentSection";

function ContentLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4">
      <Globe className="h-12 w-12 animate-bounce text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {t("preview.crawling_in_progress")}
      </p>
    </div>
  );
}

function CreationTime({ createdAt }: { createdAt: Date }) {
  const { i18n } = useTranslation();
  const { fromNow, localCreatedAt } = useRelativeTime(createdAt, i18n.language);
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <span className="flex w-fit items-center gap-2 text-sm text-muted-foreground">
          <CalendarDays size={16} /> {fromNow}
        </span>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent>{localCreatedAt}</TooltipContent>
      </TooltipPortal>
    </Tooltip>
  );
}

function BookmarkMetadata({ bookmark }: { bookmark: ZBookmark }) {
  let { author, publisher, datePublished } =
    bookmark.content.type !== BookmarkTypes.LINK
      ? {
          author: null,
          publisher: null,
          datePublished: null,
        }
      : bookmark.content;

  return (
    <div className="flex flex-col gap-2">
      <CreationTime createdAt={bookmark.createdAt} />
      {author && (
        <div className="flex w-fit items-center gap-2 text-sm text-muted-foreground">
          <User size={16} />
          <span>By {author}</span>
        </div>
      )}
      {publisher && (
        <div className="flex w-fit items-center gap-2 text-sm text-muted-foreground">
          <Building size={16} />
          <span>{publisher}</span>
        </div>
      )}
      {datePublished && <PublishedDate datePublished={datePublished} />}
    </div>
  );
}

function PublishedDate({ datePublished }: { datePublished: Date }) {
  const { i18n } = useTranslation();
  const { fromNow, localCreatedAt } = useRelativeTime(
    datePublished,
    i18n.language,
  );
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <div className="flex w-fit items-center gap-2 text-sm text-muted-foreground">
          <CalendarDays size={16} />
          <span>Published {fromNow}</span>
        </div>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent>{localCreatedAt}</TooltipContent>
      </TooltipPortal>
    </Tooltip>
  );
}

export default function BookmarkPreview({
  bookmarkId,
  initialData,
}: {
  bookmarkId: string;
  initialData?: ZBookmark;
  onClose?: () => void;
}) {
  const api = useTRPC();
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<string>("content");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { data: session } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const listQueryParam = searchParams.get("listQuery");

  let listQuery: ZGetBookmarksRequest | null = null;
  if (listQueryParam) {
    try {
      listQuery = JSON.parse(listQueryParam) as ZGetBookmarksRequest;
    } catch {
      listQuery = null;
    }
  }

  const {
    data: listData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(
    api.bookmarks.getBookmarks.infiniteQueryOptions(
      { ...listQuery, useCursorV2: true },
      {
        initialCursor: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      },
    ),
  );

  const bookmarkIds =
    listData?.pages.flatMap((page) => page.bookmarks.map((b) => b.id)) ?? [];
  const currentIndex = bookmarkIds.indexOf(bookmarkId);
  const hasListContext = currentIndex !== -1;
  const prevId =
    hasListContext && currentIndex > 0 ? bookmarkIds[currentIndex - 1] : null;
  const nextId =
    hasListContext && currentIndex < bookmarkIds.length - 1
      ? bookmarkIds[currentIndex + 1]
      : null;
  // j at the end of the loaded pages: pull the next page so the user can
  // keep going with another j, instead of dead-ending at page size.
  const atEndOfLoadedList =
    hasListContext && currentIndex === bookmarkIds.length - 1;
  const canLoadMore = atEndOfLoadedList && !!hasNextPage && !isFetchingNextPage;

  // Used only by the j/k hotkeys below to step through the list without
  // growing browser history: the preview modal is closed via router.back()
  // (see app/dashboard/@modal/(.)preview/[bookmarkId]/page.tsx), so a push
  // per keystroke would make Escape/back step through each visited
  // bookmark instead of returning straight to the list.
  //
  // When the preview was opened without an explicit list context, the
  // default bookmarks list (desc, first page) is used as a fallback so
  // j/k still work; the fallback context is preserved on navigation (no
  // listQuery param is added, the fallback is re-derived next render).
  const navigateTo = (id: string) => {
    const queryPart = listQueryParam
      ? `?listQuery=${encodeURIComponent(listQueryParam)}`
      : "";
    router.replace(`/dashboard/preview/${id}${queryPart}`);
  };

  const setIsPreviewModalOpen = useKeyboardNavigationStore(
    (state) => state.setIsPreviewModalOpen,
  );

  useEffect(() => {
    setIsPreviewModalOpen(true);
    return () => {
      setIsPreviewModalOpen(false);
    };
  }, [setIsPreviewModalOpen]);

  const nextHandler = () => {
    if (nextId) {
      navigateTo(nextId);
    } else if (canLoadMore) {
      fetchNextPage();
    }
  };

  useHotkeys(
    "j",
    nextHandler,
    { enabled: !!nextId || canLoadMore, preventDefault: true },
    [nextId, canLoadMore],
  );
  useHotkeys(
    "k",
    () => {
      if (prevId) navigateTo(prevId);
    },
    { enabled: !!prevId, preventDefault: true },
    [prevId],
  );

  // Alt+j / Alt+k step through the list even while the note editor (or any
  // other form control) has focus: react-hotkeys-hook disables plain j/k on
  // form tags by default so typing a note isn't hijacked, but the Alt
  // modifier can't be typed as note text, so these are safe to enable there.
  useHotkeys(
    "alt+j",
    nextHandler,
    {
      enabled: !!nextId || canLoadMore,
      preventDefault: true,
      enableOnFormTags: true,
    },
    [nextId, canLoadMore],
  );
  useHotkeys(
    "alt+k",
    () => {
      if (prevId) navigateTo(prevId);
    },
    { enabled: !!prevId, preventDefault: true, enableOnFormTags: true },
    [prevId],
  );

  const { data: bookmark } = useQuery(
    api.bookmarks.getBookmark.queryOptions(
      {
        bookmarkId,
      },
      {
        initialData,
        refetchInterval: (query) => {
          const data = query.state.data;
          if (!data) {
            return false;
          }
          return getBookmarkRefreshInterval(data);
        },
      },
    ),
  );

  // Check if the current user owns this bookmark
  const isOwner = bookmark ? session?.user?.id === bookmark.userId : false;

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Delete/Backspace opens the delete confirmation dialog. Plain Delete is
  // intentionally NOT enabled on form tags: while the note editor is
  // focused, Delete edits the note text instead of deleting the bookmark.
  useHotkeys(
    "delete,backspace",
    () => setDeleteDialogOpen(true),
    { enabled: isOwner && !deleteDialogOpen, preventDefault: true },
    [isOwner, deleteDialogOpen],
  );

  if (!bookmark) {
    return <FullPageSpinner />;
  }

  let content;
  switch (bookmark.content.type) {
    case BookmarkTypes.LINK: {
      content = <LinkContentSection bookmark={bookmark} />;
      break;
    }
    case BookmarkTypes.TEXT: {
      content = <TextContentSection bookmark={bookmark} />;
      break;
    }
    case BookmarkTypes.ASSET: {
      content = <AssetContentSection bookmark={bookmark} />;
      break;
    }
  }

  const sourceUrl = getSourceUrl(bookmark);
  const title = getBookmarkTitle(bookmark);

  // Common content for both layouts
  const contentSection = isBookmarkStillCrawling(bookmark) ? (
    <ContentLoading />
  ) : (
    content
  );

  const detailsSection = (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="line-clamp-2 text-ellipsis break-words text-lg font-medium">
          {!title ? "Untitled" : title}
        </p>
        {sourceUrl && (
          <Link
            href={sourceUrl}
            target="_blank"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            <span>{t("preview.view_original")}</span>
          </Link>
        )}
      </div>
      <Separator />
      <BookmarkMetadata bookmark={bookmark} />
      <SummarizeBookmarkArea bookmark={bookmark} readOnly={!isOwner} />
      <Separator />
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("common.tags")}
        </p>
        <BookmarkTagsEditor bookmark={bookmark} disabled={!isOwner} />
      </div>
      <Separator />
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("common.note")}
        </p>
        <NoteEditor bookmark={bookmark} disabled={!isOwner} />
      </div>
      <Separator />
      <AttachmentBox bookmark={bookmark} readOnly={!isOwner} />
      <HighlightsBox bookmarkId={bookmark.id} readOnly={!isOwner} />
      <Separator />
      <div className="flex items-center justify-between gap-2">
        {isOwner && (
          <ActionBar
            bookmark={bookmark}
            setDeleteDialogOpen={setDeleteDialogOpen}
          />
        )}
        {hasListContext && (
          <span className="text-sm text-muted-foreground">
            {currentIndex + 1}/{bookmarkIds.length}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Rendered at the root (not in the collapsible sidebar) so the
          confirmation dialog stays reachable even with the sidebar hidden. */}
      {isOwner && (
        <DeleteBookmarkConfirmationDialog
          bookmark={bookmark}
          open={deleteDialogOpen}
          setOpen={setDeleteDialogOpen}
        />
      )}
      {/* Render original layout for wide screens */}
      <div className="hidden h-full flex-col overflow-hidden bg-background lg:flex">
        <div className="flex min-h-0 flex-1">
          <div className="relative h-full flex-1 overflow-auto px-4 py-4">
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="absolute right-4 top-4 z-10 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {sidebarCollapsed ? (
                <PanelRightOpen size={20} />
              ) : (
                <PanelRightClose size={20} />
              )}
            </button>
            {contentSection}
          </div>
          {!sidebarCollapsed && (
            <div className="flex w-1/3 flex-col gap-3 overflow-auto border-l bg-muted/40 p-5">
              {detailsSection}
            </div>
          )}
        </div>
      </div>
      {/* Render tabbed layout for narrow/vertical screens */}
      <div className="flex h-full w-full flex-col overflow-hidden lg:hidden">
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <TabsList className="z-10 mx-4 mt-2 grid w-auto grid-cols-2">
            <TabsTrigger value="content">
              {t("preview.tabs.content")}
            </TabsTrigger>
            <TabsTrigger value="details">
              {t("preview.tabs.details")}
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="content"
            className="h-full flex-1 overflow-hidden overflow-y-auto bg-background px-4 py-3 data-[state=inactive]:hidden"
          >
            {contentSection}
          </TabsContent>
          <TabsContent
            value="details"
            className="h-full overflow-y-auto bg-background px-4 py-3 data-[state=inactive]:hidden"
          >
            {detailsSection}
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
