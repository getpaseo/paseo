ALTER TABLE "message" ADD COLUMN "quoted_message_id" text;
--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_quoted_fkey" FOREIGN KEY ("quoted_message_id") REFERENCES "message"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_quoted_idx" ON "message" ("quoted_message_id");
