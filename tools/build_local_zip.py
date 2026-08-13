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

# 檔名一律用 ASCII。UTF-8 旗標我們有設，但 Windows 檔案總管的解壓縮
# 常常忽略它、改用系統編碼，中文檔名就變成亂碼。內容仍然是中文。
GUIDE_NAME = "INSTALL.txt"

README = ROOT / "README.md"
MARK_START = "<!-- INSTALL:START -->"
MARK_END = "<!-- INSTALL:END -->"


def guide_text() -> str:
    """安裝說明只有一份來源：README 的安裝章節。

    複製一份放這裡的話，改了 README 而忘了改這裡，學員拿到的就是舊步驟，
    而且沒有任何跡象顯示它過期了。
    """
    md = README.read_text(encoding="utf-8")
    body = md.split(MARK_START)[1].split(MARK_END)[0].strip()
    # 轉成純文字：拿掉 Markdown 的標記，保留階層感
    out = []
    for line in body.split("\n"):
        line = line.replace("**", "").replace("`", "")
        if line.startswith("### "):
            line = f"\n【{line[4:].strip()}】"
        elif line.startswith("- "):
            line = f"・{line[2:]}"
        out.append(line)
    return "Mesh Sync 安裝說明（三分鐘）\n\n" + "\n".join(out).strip() + "\n"


def main():
    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    assert "key" in manifest, "本機版必須保留 key 欄位，否則擴充 ID 會變、OAuth 會失敗"
    version = manifest["version"]

    out = ROOT / f"mesh-sync-local-v{version}.zip"
    out.unlink(missing_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp) / FOLDER
        shutil.copytree(SRC, stage, ignore=shutil.ignore_patterns(".*", "__MACOSX"))
        (Path(tmp) / GUIDE_NAME).write_text(guide_text(), encoding="utf-8")

        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for path in sorted(Path(tmp).rglob("*")):
                if path.is_file():
                    name = str(path.relative_to(tmp))
                    assert name.isascii(), f"zip 內的檔名要用 ASCII，避免 Windows 解壓亂碼：{name}"
                    z.write(path, name)

    print(f"已產生 {out.name}（{out.stat().st_size / 1024:.1f} KB）")
    print(f"  擴充 ID 固定：key 欄位保留")
    print(f"  解壓後資料夾：{FOLDER}/")


if __name__ == "__main__":
    main()
