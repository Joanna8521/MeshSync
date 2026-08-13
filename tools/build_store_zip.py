#!/usr/bin/env python3
"""打包上架用的 zip。

商店不接受 manifest 的 `key` 欄位（那是本機載入用來固定擴充 ID 的），
所以商店版要把它拿掉；上架後的 ID 由商店指派。

因為 ID 不同，OAuth 用戶端也要另外準備一組（同一個 GCP 專案即可）。
拿到商店 ID、在 GCP 建好對應的用戶端之後，用 --client-id 指定：

    python3 tools/build_store_zip.py --client-id 123-abc.apps.googleusercontent.com

不指定就沿用 extension/manifest.json 裡現有的值（第一次上傳草稿取得 ID 時可先這樣）。
"""

import argparse
import json
import shutil
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--client-id", help="商店版要使用的 OAuth client ID")
    args = ap.parse_args()

    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    removed_key = manifest.pop("key", None)
    if args.client_id:
        manifest["oauth2"]["client_id"] = args.client_id

    version = manifest["version"]
    out = ROOT / f"mesh-sync-store-v{version}.zip"
    out.unlink(missing_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp) / "ext"
        shutil.copytree(SRC, stage, ignore=shutil.ignore_patterns(".*", "__MACOSX"))
        (stage / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    z.write(path, path.relative_to(stage))

    print(f"已產生 {out.name}（{out.stat().st_size / 1024:.1f} KB）")
    print(f"  key 欄位：{'已移除' if removed_key else '原本就沒有'}")
    print(f"  client_id：{manifest['oauth2']['client_id']}")


if __name__ == "__main__":
    main()
