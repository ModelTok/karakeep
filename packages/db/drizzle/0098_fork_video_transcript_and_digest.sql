ALTER TABLE `bookmarkLinks` ADD `transcript` text;--> statement-breakpoint
ALTER TABLE `bookmarkLinks` ADD `transcriptionStatus` text;--> statement-breakpoint
ALTER TABLE `user` ADD `digestEnabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `digestLanguage` text;