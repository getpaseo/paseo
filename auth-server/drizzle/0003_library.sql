CREATE TABLE IF NOT EXISTS "library_entry" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text,
  "payload" jsonb NOT NULL,
  "icon_url" text,
  "source" text NOT NULL DEFAULT 'custom',
  "catalog_id" text,
  "scope" text NOT NULL,
  "scope_id" text,
  "visibility" text NOT NULL DEFAULT 'private',
  "created_by" text NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "deleted_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_entry_scope_idx" ON "library_entry" ("scope", "scope_id", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_entry_created_by_idx" ON "library_entry" ("created_by");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_entry_scope_name_unique" ON "library_entry" ("scope", "scope_id", "kind", "name");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "library_activation" (
  "entry_id" text NOT NULL REFERENCES "library_entry"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "active" boolean NOT NULL DEFAULT true,
  "sync_targets" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "activated_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("entry_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_activation_user_idx" ON "library_activation" ("user_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "catalog_cache" (
  "source" text NOT NULL,
  "query_key" text NOT NULL DEFAULT '',
  "data" jsonb NOT NULL,
  "fetched_at" timestamp NOT NULL DEFAULT now(),
  "expires_at" timestamp NOT NULL,
  PRIMARY KEY ("source", "query_key")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "catalog_icon_cache" (
  "hash" text PRIMARY KEY NOT NULL,
  "source_url" text NOT NULL,
  "mime_type" text NOT NULL,
  "bytes" text NOT NULL,
  "fetched_at" timestamp NOT NULL DEFAULT now()
);
