"""Package the verified dist tree reproducibly for GitHub and Chrome Web Store."""

import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def main():
    root = Path(__file__).resolve().parent.parent
    dist = root / "dist"
    version = json.loads((root / "package.json").read_text())["version"]
    manifest = json.loads((dist / "manifest.json").read_text())
    if manifest["version"] != version:
        raise SystemExit("Run npm run verify before packaging: dist version is stale")

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    archive = args.output or root / "store" / f"multi-ai-chat-store-v{version}.zip"
    if archive.resolve().is_relative_to(dist.resolve()):
        raise SystemExit("The archive must be outside dist")
    archive.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(path for path in dist.rglob("*") if path.is_file())
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for path in files:
            if path.is_symlink() or not path.resolve().is_relative_to(dist.resolve()):
                raise SystemExit(f"Refusing linked build file: {path}")
            entry = zipfile.ZipInfo(path.relative_to(dist).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            bundle.writestr(entry, path.read_bytes(), compresslevel=9)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    Path(str(archive) + ".sha256").write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    print(f"Packaged {len(files)} files: {archive}\nSHA-256: {digest}")


if __name__ == "__main__":
    main()
