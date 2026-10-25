CREATE TABLE `basalCalibrations` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`model` text NOT NULL,
	`mode` text NOT NULL,
	`targets` text NOT NULL,
	`metrics` text NOT NULL,
	`path` text NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `basalCalibrations_userId_idx` ON `basalCalibrations` (`userId`);--> statement-breakpoint
CREATE TABLE `basalFeedRatings` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`feedId` text NOT NULL,
	`rating` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`modifiedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feedId`) REFERENCES `rssFeeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `basalFeedRatings_userId_idx` ON `basalFeedRatings` (`userId`);--> statement-breakpoint
CREATE INDEX `basalFeedRatings_feedId_idx` ON `basalFeedRatings` (`feedId`);--> statement-breakpoint
CREATE UNIQUE INDEX `basalFeedRatings_userId_feedId_unique` ON `basalFeedRatings` (`userId`,`feedId`);--> statement-breakpoint
CREATE TABLE `basalFeedScores` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`feedId` text NOT NULL,
	`expectedLevel` real NOT NULL,
	`label` text NOT NULL,
	`probabilities` text NOT NULL,
	`confidence` real NOT NULL,
	`model` text NOT NULL,
	`calibrationId` text,
	`stateKind` text DEFAULT 'feed_summary' NOT NULL,
	`createdAt` integer NOT NULL,
	`modifiedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feedId`) REFERENCES `rssFeeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `basalFeedScores_userId_idx` ON `basalFeedScores` (`userId`);--> statement-breakpoint
CREATE INDEX `basalFeedScores_feedId_idx` ON `basalFeedScores` (`feedId`);--> statement-breakpoint
CREATE INDEX `basalFeedScores_calibrationId_idx` ON `basalFeedScores` (`calibrationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `basalFeedScores_userId_feedId_unique` ON `basalFeedScores` (`userId`,`feedId`);--> statement-breakpoint
CREATE TABLE `basalJobs` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error` text,
	`createdAt` integer NOT NULL,
	`finishedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `basalJobs_userId_idx` ON `basalJobs` (`userId`);--> statement-breakpoint
CREATE INDEX `basalJobs_userId_status_idx` ON `basalJobs` (`userId`,`status`);--> statement-breakpoint
CREATE TABLE `basalRatings` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`bookmarkId` text NOT NULL,
	`rating` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`modifiedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `basalRatings_userId_idx` ON `basalRatings` (`userId`);--> statement-breakpoint
CREATE INDEX `basalRatings_bookmarkId_idx` ON `basalRatings` (`bookmarkId`);--> statement-breakpoint
CREATE UNIQUE INDEX `basalRatings_userId_bookmarkId_unique` ON `basalRatings` (`userId`,`bookmarkId`);--> statement-breakpoint
CREATE TABLE `basalScores` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`bookmarkId` text NOT NULL,
	`expectedLevel` real NOT NULL,
	`label` text NOT NULL,
	`probabilities` text NOT NULL,
	`confidence` real NOT NULL,
	`model` text NOT NULL,
	`calibrationId` text,
	`createdAt` integer NOT NULL,
	`modifiedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `basalScores_userId_idx` ON `basalScores` (`userId`);--> statement-breakpoint
CREATE INDEX `basalScores_bookmarkId_idx` ON `basalScores` (`bookmarkId`);--> statement-breakpoint
CREATE INDEX `basalScores_calibrationId_idx` ON `basalScores` (`calibrationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `basalScores_userId_bookmarkId_unique` ON `basalScores` (`userId`,`bookmarkId`);--> statement-breakpoint
CREATE TABLE `basalSettings` (
	`userId` text PRIMARY KEY NOT NULL,
	`autoArchive` integer DEFAULT false NOT NULL,
	`archiveThreshold` real DEFAULT 0.34 NOT NULL,
	`minConfidence` real DEFAULT 0.9 NOT NULL,
	`maxItems` integer DEFAULT 50 NOT NULL,
	`modifiedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
