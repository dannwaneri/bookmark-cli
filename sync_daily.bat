@echo off
cd /d C:\Users\DELL\bookmark-cli

echo [%date% %time%] Starting daily sync >> logs\sync.log

C:\Python314\python.exe bookmark.py sync >> logs\sync.log 2>&1
echo [%date% %time%] Bookmark sync done >> logs\sync.log

C:\Python314\python.exe bookmark.py sync-likes >> logs\sync.log 2>&1
echo [%date% %time%] Likes sync done >> logs\sync.log

C:\Python314\python.exe bookmark.py ingest-vector --batch 100 >> logs\sync.log 2>&1
echo [%date% %time%] Vector ingest done >> logs\sync.log

echo [%date% %time%] Daily sync complete >> logs\sync.log
