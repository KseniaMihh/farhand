-- #80: a profile points at its avatar File, not at a URL.
--
-- Additive only. "avatarUrl" stays: migrations run before the new code is
-- live, and the version still serving during the build selects that column.
-- Dropping it here would break the site for the length of a deploy
-- (docs/14-deployment.md). A later migration drops it.

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "avatarFileId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Profile_avatarFileId_key" ON "Profile"("avatarFileId");

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_avatarFileId_fkey" FOREIGN KEY ("avatarFileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;

