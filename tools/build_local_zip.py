#!/usr/bin/env python3
"""打包給學員本機安裝的 zip（載入未封裝項目用）。

跟商店版的差別：這包**保留** manifest 的 `key` 欄位，
所以每個人載入後的擴充 ID 都一樣，共用同一組 OAuth 用戶端才會成立。

解壓後會得到一個資料夾，直接在 chrome://extensions 選它即可。

用法：python3 tools/build_local_zip.py
"""

import json
import shutil
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"
FOLDER = "mesh-sync-extension"

GUIDE = """Mesh Sync 安裝說明（三分鐘）

1. 把這個資料夾放到你放得住的地方（例如「文件」）。
   注意：安裝後不能刪除或搬走它，擴充是直接從這個資料夾執行的。

2. 打開 Chrome，網址列輸入：chrome://extensions
   右上角把「開發人員模式」打開。

3. 按左上角「載入未封裝項目」，選取這個資料夾（裡面要看得到
   manifest.json 這個檔案），按「選取」。

4. 裝好後會自動打開設定導覽頁，照著做兩件事：
   （一）點工具列的 Mesh Sync 圖示，按「連接 Google」，用自己的
        Google 帳號授權。你的內容只會寫進你自己的雲端硬碟。
   （二）把導覽頁上那段 prompt 複製，貼到 ChatGPT 自訂指令
        （或 Claude 個人偏好、Gemini Saved Info）。

5. 開一個 AI 對話，選取任一段文字，旁邊會浮出「⚡ 存入脈絡」，
   按下去就寫進你的 Google Drive 了。

常見問題

・選了資料夾卻說「資訊清單檔案遺失」→ 選錯層了，要選到裡面有
  manifest.json 的那一層。
・按了沒反應 → 回到對話分頁按 Cmd+R（Windows 是 F5）重新整理，
  擴充需要頁面重新載入才會生效。
・想確認有沒有正常運作 → 點擴充圖示，按「檢查」，會顯示這個分頁
  偵測到幾則訊息。
"""


def main():
    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    assert "key" in manifest, "本機版必須保留 key 欄位，否則擴充 ID 會變、OAuth 會失敗"
    version = manifest["version"]

    out = ROOT / f"mesh-sync-local-v{version}.zip"
    out.unlink(missing_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp) / FOLDER
        shutil.copytree(SRC, stage, ignore=shutil.ignore_patterns(".*", "__MACOSX"))
        (Path(tmp) / "安裝說明.txt").write_text(GUIDE, encoding="utf-8")

        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for path in sorted(Path(tmp).rglob("*")):
                if path.is_file():
                    z.write(path, path.relative_to(tmp))

    print(f"已產生 {out.name}（{out.stat().st_size / 1024:.1f} KB）")
    print(f"  擴充 ID 固定：key 欄位保留")
    print(f"  解壓後資料夾：{FOLDER}/")


if __name__ == "__main__":
    main()
