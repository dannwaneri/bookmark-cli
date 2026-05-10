"""
Automated Gemma 4 Challenge demo recorder.
Uses Win+Alt+R (Xbox Game Bar) to start/stop recording.
Types the full demo sequence in THIS terminal window.

Usage:
  1. Open PowerShell, cd to bookmark-cli
  2. Run: python record_demo.py
  3. When prompted, press ENTER — then don't touch anything
  4. Video saves to Videos > Captures

Requirements:
  pip install pyautogui
"""

import time
import pyautogui
import sys

API_KEY = "nma2026"
WORKER_URL = "https://vectorize-mcp-worker.fpl-test.workers.dev"

pyautogui.PAUSE = 0.03
pyautogui.FAILSAFE = True  # move mouse to top-left to abort

def send_hotkey(*keys):
    pyautogui.hotkey(*keys)
    time.sleep(0.4)

def type_cmd(text, char_delay=0.035):
    """Type text character by character — looks natural on screen."""
    pyautogui.typewrite(text, interval=char_delay)

def enter(pause=1.0):
    pyautogui.press("enter")
    time.sleep(pause)

def blank(pause=1.2):
    pyautogui.press("enter")
    time.sleep(pause)

def wait(s):
    time.sleep(s)

def start_recording():
    print("Starting Game Bar recording...")
    send_hotkey("win", "alt", "r")
    wait(2)  # let the recording indicator appear and settle

def stop_recording():
    print("\nStopping recording...")
    send_hotkey("win", "alt", "r")
    wait(1)

def run_demo():
    # ── Clear screen for clean start ──────────────────────────────────
    type_cmd("cls")
    enter(0.8)

    # ── Title comment ─────────────────────────────────────────────────
    type_cmd("# bookmark-cli + Gemma 4 MoE: 45,000 tweets, one reflection layer")
    enter(2.0)

    # ── Command 1: semantic-hooks ─────────────────────────────────────
    type_cmd("# Find content from your archive using meaning, not keywords")
    enter(0.8)
    type_cmd('python bookmark.py semantic-hooks "RAG failure modes" --limit 5')
    enter(15.0)  # wait for vectorize response (extra buffer for DNS resolution)

    blank(2.0)

    # ── Command 2: benchmark ──────────────────────────────────────────
    type_cmd("# Gemma 4 MoE vs Kimi K2.5 — same query, same infrastructure")
    enter(0.8)
    type_cmd(
        "Invoke-WebRequest "
        f'-Uri "{WORKER_URL}/benchmark" '
        "-Method POST "
        f'-Headers @{{"Authorization"="Bearer {API_KEY}"; "Content-Type"="application/json"}} '
        '-Body \'{"query": "What are the common failure modes of RAG systems?"}\' '
        "| ConvertFrom-Json | ConvertTo-Json -Depth 5"
    )
    enter(22.0)  # both models take ~10-15s each

    blank(2.0)

    # ── Command 3: show active reflection model ───────────────────────
    type_cmd("# Active models — reflection layer is now Gemma 4")
    enter(0.8)
    type_cmd(
        "Invoke-WebRequest "
        f'-Uri "{WORKER_URL}/stats" '
        f'-Headers @{{"Authorization"="Bearer {API_KEY}"}} '
        "| ConvertFrom-Json | Select-Object -ExpandProperty models"
    )
    enter(5.0)

    blank(1.5)

    # ── Closing comment ───────────────────────────────────────────────
    type_cmd("# Full pipeline: embed → retrieve → rerank → reflect — all inside one Cloudflare Worker")
    enter(3.0)

def countdown(n):
    for i in range(n, 0, -1):
        print(f"  Starting in {i}...", end="\r", flush=True)
        time.sleep(1)
    print()

def main():
    print("=" * 60)
    print("  Gemma 4 Challenge — Automated Demo Recorder")
    print("=" * 60)
    print()
    print("What happens:")
    print("  1. Xbox Game Bar recording starts (Win+Alt+R)")
    print("  2. Demo commands type themselves in THIS window")
    print("  3. Recording stops automatically")
    print("  4. Video saved to: Videos > Captures")
    print()
    print("Before you press ENTER:")
    print("  [*] Click on THIS PowerShell window to give it focus")
    print("  [*] Make sure Xbox Game Bar is enabled (Win+G to check)")
    print("  [*] Don't touch mouse or keyboard after pressing ENTER")
    print("  [*] Emergency abort: move mouse to top-left corner")
    print()
    print("Auto-starting in 10 seconds — click this window now if not focused...")
    countdown(10)

    start_recording()

    try:
        run_demo()
    except pyautogui.FailSafeException:
        print("\n\nAborted (mouse moved to corner).")
        sys.exit(1)

    wait(2)
    stop_recording()

    print("\nDone! Find your video in: Videos > Captures")

if __name__ == "__main__":
    main()
