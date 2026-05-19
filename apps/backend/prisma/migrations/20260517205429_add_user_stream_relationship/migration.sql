-- CreateTable
CREATE TABLE "_StreamToUser" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_StreamToUser_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_StreamToUser_B_index" ON "_StreamToUser"("B");

-- AddForeignKey
ALTER TABLE "_StreamToUser" ADD CONSTRAINT "_StreamToUser_A_fkey" FOREIGN KEY ("A") REFERENCES "Stream"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StreamToUser" ADD CONSTRAINT "_StreamToUser_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
